/**
 * Orchestration for rule-based mail sorting.
 *
 *   plan (read-only)  ->  preview  ->  apply  ->  rollback
 *
 * Planning and mutating are separate tool calls on purpose. A plan is a file on
 * disk listing exactly which labels would move on which messages; applying
 * takes a plan id and can only do what that file already said. Nothing reaches
 * the network beyond Gmail itself, and nothing reads a message body — planning
 * fetches headers only.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeSecretJsonAtomic, ensureSecureDirFor, SECRET_DIR_MODE } from './secure-store.js';
import { listLabels, getOrCreateLabel } from './label-manager.js';
import { mapWithConcurrency, processItemsIndividually } from './batch-utils.js';
import {
    normalizeMessage,
    matchHardRules,
    sanitizeActions,
    NormalizedMessage,
    TriageActions,
    TriageRule,
} from './triage-rules.js';

/**
 * Gmail's per-user quota is 250 units/second. messages.get in metadata format
 * costs 1 unit (full format costs 5), so header-only planning is both cheaper
 * and the reason this concurrency is safe.
 */
const GMAIL_CONCURRENCY = 10;
/** Only the headers a rule can match on are requested. */
const METADATA_HEADERS = ['From', 'Subject', 'Date', 'List-Id', 'List-Unsubscribe'];
const GMAIL_PAGE_SIZE = 100;
/** Keeps a stray maxMessages from walking the whole mailbox. */
const MAX_LIST_PAGES = 20;
/** Runs kept on disk before the oldest are pruned. */
const RUNS_RETAINED = 50;

export interface AppliedRecord {
    at: string;
    addedLabelIds: string[];
    removedLabelIds: string[];
}

export interface TriageRunItem {
    messageId: string;
    threadId: string;
    subject: string;
    from: string;
    receivedAt: string;
    /** The rule that claimed this message, or undefined when none did. */
    ruleName?: string;
    actions: TriageActions;
    applied?: AppliedRecord;
    rolledBackAt?: string;
}

export interface TriageRun {
    version: 1;
    runId: string;
    createdAt: string;
    query: string;
    shadowMode: boolean;
    /** Messages the query returned but no rule matched. */
    unmatched: number;
    items: TriageRunItem[];
    appliedAt?: string;
    rolledBackAt?: string;
}

export interface PlanOptions {
    query: string;
    maxMessages: number;
    rules: TriageRule[];
    shadowMode?: boolean;
    /** Keep messages no rule matched in the plan, with no action, so they are visible. */
    includeUnmatched?: boolean;
}

/** `run-<ISO-ish timestamp>-<random>`; the charset is what runIdIsSafe accepts. */
export function newRunId(now: Date = new Date()): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    return `run-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Run ids arrive as tool arguments, so they are caller-controlled strings that
 * become a filename. Whitelist the charset rather than stripping bad parts out.
 */
export function runIdIsSafe(runId: string): boolean {
    return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(runId);
}

export function runFilePath(runsDir: string, runId: string): string {
    if (!runIdIsSafe(runId)) {
        throw new Error(`Invalid run id "${runId}"`);
    }
    return path.join(runsDir, `${runId}.json`);
}

/** Create the runs directory with owner-only permissions. */
export function ensureRunsDir(runsDir: string): void {
    if (!fs.existsSync(runsDir)) {
        fs.mkdirSync(runsDir, { recursive: true, mode: SECRET_DIR_MODE });
    }
}

/**
 * Run files hold subjects and sender addresses for real mail, so they get the
 * same owner-only treatment as the credential file.
 */
export function saveRun(runsDir: string, run: TriageRun): string {
    const filePath = runFilePath(runsDir, run.runId);
    ensureSecureDirFor(filePath);
    writeSecretJsonAtomic(filePath, run);
    return filePath;
}

export function loadRun(runsDir: string, runId: string): TriageRun {
    const filePath = runFilePath(runsDir, runId);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Triage run "${runId}" not found. Run triage_plan first.`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function listRuns(runsDir: string, limit: number = 20): Array<{ runId: string; modifiedAt: string }> {
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir)
        .filter(name => name.endsWith('.json'))
        .map(name => ({
            runId: name.slice(0, -'.json'.length),
            modifiedAt: fs.statSync(path.join(runsDir, name)).mtime.toISOString(),
        }))
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        .slice(0, limit);
}

/**
 * Drop the oldest runs beyond `keep`.
 *
 * Every plan writes a file full of mail metadata. Without a bound, a daily
 * sorting habit leaves years of inbox history in the config directory — data
 * the feature has no further use for.
 */
export function pruneRuns(runsDir: string, keep: number = RUNS_RETAINED): number {
    const doomed = listRuns(runsDir, Number.MAX_SAFE_INTEGER).slice(keep);
    let removed = 0;
    for (const run of doomed) {
        try {
            fs.unlinkSync(path.join(runsDir, `${run.runId}.json`));
            removed++;
        } catch { /* already gone, or read-only mount */ }
    }
    return removed;
}

/** Collect message ids for `query`, paging until maxMessages or the mailbox runs out. */
async function collectMessageIds(gmail: any, query: string, maxMessages: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    while (ids.length < maxMessages && pages < MAX_LIST_PAGES) {
        pages++;
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: Math.min(GMAIL_PAGE_SIZE, maxMessages - ids.length),
            pageToken,
        });
        for (const message of response.data.messages || []) {
            if (message.id) ids.push(message.id);
            if (ids.length >= maxMessages) break;
        }
        pageToken = response.data.nextPageToken || undefined;
        if (!pageToken) break;
    }

    return ids;
}

async function buildLabelNameMap(gmail: any): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const { all } = await listLabels(gmail);
        for (const label of all || []) {
            if (label.id && label.name) map.set(label.id, label.name);
        }
    } catch {
        // Label names only matter for hasLabel/lacksLabel rules and for a
        // readable preview; a plan that cannot read them still matches
        // correctly on sender and subject, so this is not worth failing over.
    }
    return map;
}

function toRunItem(message: NormalizedMessage, actions: TriageActions, ruleName?: string): TriageRunItem {
    return {
        messageId: message.id,
        threadId: message.threadId,
        // The preview is read by a human and by a model; a full-length subject
        // from a hostile sender is the wrong thing to splice into either.
        subject: message.subject.slice(0, 200),
        from: message.from.email,
        receivedAt: message.receivedAt,
        ruleName,
        actions,
    };
}

/**
 * Match messages against the rule set and write a plan. Mutates nothing in Gmail.
 */
export async function planTriage(
    gmail: any,
    runsDir: string,
    options: PlanOptions,
): Promise<TriageRun> {
    const messageIds = await collectMessageIds(gmail, options.query, options.maxMessages);
    const labelNames = await buildLabelNameMap(gmail);

    // mapWithConcurrency rejects the whole call on the first failure, which
    // would throw away a hundred good reads because one message was deleted
    // between the list and the get. Settle each read here instead.
    const fetched = await mapWithConcurrency(messageIds, GMAIL_CONCURRENCY, async (id) => {
        try {
            const detail = await gmail.users.messages.get({
                userId: 'me',
                id,
                format: 'metadata',
                metadataHeaders: METADATA_HEADERS,
            });
            return normalizeMessage(detail.data, labelNames);
        } catch {
            return undefined;
        }
    });

    const items: TriageRunItem[] = [];
    let unmatched = 0;

    for (const message of fetched) {
        if (!message) continue;
        const rule = matchHardRules(message, options.rules);
        if (rule) {
            items.push(toRunItem(message, sanitizeActions(rule.actions, options.shadowMode), rule.name));
        } else {
            unmatched++;
            if (options.includeUnmatched) {
                items.push(toRunItem(message, { addLabels: [] }));
            }
        }
    }

    const run: TriageRun = {
        version: 1,
        runId: newRunId(),
        createdAt: new Date().toISOString(),
        query: options.query,
        shadowMode: Boolean(options.shadowMode),
        unmatched,
        items,
    };

    ensureRunsDir(runsDir);
    saveRun(runsDir, run);
    pruneRuns(runsDir);
    return run;
}

export interface RunSummary {
    total: number;
    matched: number;
    unmatched: number;
    archive: number;
    applied: number;
    byRule: Record<string, number>;
    byLabel: Record<string, number>;
}

export function summarizeRun(run: TriageRun): RunSummary {
    const byRule: Record<string, number> = {};
    const byLabel: Record<string, number> = {};
    let matched = 0;
    let archive = 0;
    let applied = 0;

    for (const item of run.items) {
        if (item.ruleName) {
            matched++;
            byRule[item.ruleName] = (byRule[item.ruleName] || 0) + 1;
        }
        if (item.actions.archive) archive++;
        if (item.applied && !item.rolledBackAt) applied++;
        for (const label of item.actions.addLabels) {
            byLabel[label] = (byLabel[label] || 0) + 1;
        }
    }

    return { total: run.items.length, matched, unmatched: run.unmatched, archive, applied, byRule, byLabel };
}

export interface ApplyOptions {
    /** Apply only these message ids; omit for every item that has an action. */
    onlyMessageIds?: string[];
    /** Apply only the items claimed by these rules. */
    onlyRules?: string[];
    /** Report what would happen without calling Gmail. */
    dryRun?: boolean;
}

interface ResolvedChange {
    item: TriageRunItem;
    addLabelIds: string[];
    removeLabelIds: string[];
}

function hasAnyAction(actions: TriageActions): boolean {
    return (actions.addLabels?.length ?? 0) > 0
        || (actions.removeLabels?.length ?? 0) > 0
        || Boolean(actions.archive)
        || Boolean(actions.markRead);
}

/**
 * Turn label NAMES into ids, creating the missing ones once per name.
 *
 * Labels are created here rather than at plan time so a plan that is never
 * applied leaves no debris in the user's label list.
 */
async function resolveLabelIds(gmail: any, names: string[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    for (const name of names) {
        // Gmail's own system labels are addressed by their upper-case id and
        // cannot be created; getOrCreateLabel would try and fail.
        if (/^[A-Z][A-Z_]*$/.test(name)) {
            resolved.set(name, name);
            continue;
        }
        const label = await getOrCreateLabel(gmail, name);
        if (label?.id) resolved.set(name, label.id);
    }
    return resolved;
}

/** Apply a plan. Only label changes are ever issued. */
export async function applyRun(
    gmail: any,
    runsDir: string,
    run: TriageRun,
    options: ApplyOptions = {},
): Promise<{ applied: number; skipped: number; failures: Array<{ messageId: string; error: string }> }> {
    const onlyIds = options.onlyMessageIds ? new Set(options.onlyMessageIds) : undefined;
    const onlyRules = options.onlyRules ? new Set(options.onlyRules) : undefined;

    const pending = run.items.filter((item) => {
        if (item.applied && !item.rolledBackAt) return false;
        if (onlyIds && !onlyIds.has(item.messageId)) return false;
        if (onlyRules && !(item.ruleName && onlyRules.has(item.ruleName))) return false;
        return hasAnyAction(item.actions);
    });

    const skipped = run.items.length - pending.length;

    if (options.dryRun) {
        return { applied: 0, skipped, failures: [] };
    }

    const neededNames = new Set<string>();
    for (const item of pending) {
        for (const name of item.actions.addLabels || []) neededNames.add(name);
        for (const name of item.actions.removeLabels || []) neededNames.add(name);
    }
    const labelIds = await resolveLabelIds(gmail, [...neededNames]);

    const changes: ResolvedChange[] = pending.map((item) => {
        const addLabelIds = (item.actions.addLabels || [])
            .map(name => labelIds.get(name))
            .filter((id): id is string => Boolean(id));
        const removeLabelIds = (item.actions.removeLabels || [])
            .map(name => labelIds.get(name))
            .filter((id): id is string => Boolean(id));
        if (item.actions.archive) removeLabelIds.push('INBOX');
        if (item.actions.markRead) removeLabelIds.push('UNREAD');
        return { item, addLabelIds, removeLabelIds };
    }).filter(change => change.addLabelIds.length > 0 || change.removeLabelIds.length > 0);

    const appliedAt = new Date().toISOString();
    const { failures } = await processItemsIndividually(
        changes,
        GMAIL_CONCURRENCY,
        async (change) => {
            await gmail.users.messages.modify({
                userId: 'me',
                id: change.item.messageId,
                requestBody: {
                    addLabelIds: change.addLabelIds,
                    removeLabelIds: change.removeLabelIds,
                },
            });
            // Record the delta that was issued, not a snapshot of the labels.
            // Rollback then reverses exactly this change and leaves alone
            // anything the user did to the message in between.
            change.item.applied = {
                at: appliedAt,
                addedLabelIds: change.addLabelIds,
                removedLabelIds: change.removeLabelIds,
            };
            delete change.item.rolledBackAt;
        },
    );

    run.appliedAt = appliedAt;
    delete run.rolledBackAt;
    saveRun(runsDir, run);

    return {
        applied: changes.length - failures.length,
        skipped,
        failures: failures.map(failure => ({
            messageId: (failure.item as ResolvedChange).item.messageId,
            error: failure.error.message,
        })),
    };
}

/** Reverse an applied run: remove what it added, restore what it removed. */
export async function rollbackRun(
    gmail: any,
    runsDir: string,
    run: TriageRun,
): Promise<{ reverted: number; failures: Array<{ messageId: string; error: string }> }> {
    const applied = run.items.filter(item => item.applied && !item.rolledBackAt);
    if (applied.length === 0) {
        return { reverted: 0, failures: [] };
    }

    const rolledBackAt = new Date().toISOString();
    const { failures } = await processItemsIndividually(
        applied,
        GMAIL_CONCURRENCY,
        async (item) => {
            await gmail.users.messages.modify({
                userId: 'me',
                id: item.messageId,
                requestBody: {
                    addLabelIds: item.applied!.removedLabelIds,
                    removeLabelIds: item.applied!.addedLabelIds,
                },
            });
            item.rolledBackAt = rolledBackAt;
        },
    );

    run.rolledBackAt = rolledBackAt;
    saveRun(runsDir, run);

    return {
        reverted: applied.length - failures.length,
        failures: failures.map(failure => ({
            messageId: (failure.item as TriageRunItem).messageId,
            error: failure.error.message,
        })),
    };
}
