/**
 * Deterministic mail sorting rules.
 *
 * Gmail's own filters only ever see new mail, so a filter created today does
 * nothing about the thousand messages already sitting in the inbox. These rules
 * are the retroactive half: the same kind of condition, evaluated locally
 * against messages a query already selected.
 *
 * Everything here works on message HEADERS only — sender, subject, List-Id,
 * existing labels. No body is fetched, decoded or inspected, which is why
 * classification costs one Gmail quota unit per message instead of five and why
 * no mail content is ever held in memory longer than the match takes.
 *
 * Conditions are plain string comparisons, never regular expressions. A rule
 * set can be written by a model that has just read untrusted mail, and a
 * pattern is an easy thing for that mail to influence; substring and suffix
 * tests have no pathological input, so a bad rule can at worst mislabel.
 */

import fs from 'fs';
import path from 'path';

export interface NormalizedSender {
    name: string;
    email: string;
    domain: string;
}

/** Everything a rule may look at. Deliberately header-only. */
export interface NormalizedMessage {
    id: string;
    threadId: string;
    from: NormalizedSender;
    subject: string;
    receivedAt: string;
    /** Label IDs as Gmail reports them. */
    labelIds: string[];
    /** Readable label names where the caller could resolve them. */
    labelNames: string[];
    /** List-Id header value, lower-cased. Empty when absent. */
    listId: string;
    /** Whether the message carries a List-Unsubscribe header. */
    hasListUnsubscribe: boolean;
}

/**
 * What a rule may do.
 *
 * There is no delete, send or forward here, and that is the point: the pipeline
 * is confined to label changes, which are reversible. Archiving is "remove
 * INBOX" and marking read is "remove UNREAD" — both are just labels too.
 */
export interface TriageActions {
    /** Label NAMES (not IDs) — created on demand at apply time. */
    addLabels: string[];
    removeLabels?: string[];
    /** Remove INBOX. */
    archive?: boolean;
    /** Remove UNREAD. */
    markRead?: boolean;
}

/**
 * Within one field the values are OR'd; across fields they are AND'd. A rule
 * with no conditions at all never matches, so a half-written rule cannot
 * quietly become a catch-all that relabels the whole mailbox.
 */
export interface TriageConditions {
    /** Exact sender address, case-insensitive. */
    fromEquals?: string[];
    /** Sender domain; matches the domain itself and any subdomain of it. */
    fromDomain?: string[];
    /** Substring of the sender display name or address. */
    fromContains?: string[];
    /** Substring of the subject, case-insensitive. */
    subjectContains?: string[];
    /** Substring of the List-Id header — the reliable way to catch one mailing list. */
    listIdContains?: string[];
    /** True matches bulk mail carrying List-Unsubscribe; false matches mail without it. */
    hasListUnsubscribe?: boolean;
    /** Message already carries this label name. */
    hasLabel?: string[];
    /** Message does NOT carry this label name — use it to keep a rule from re-running. */
    lacksLabel?: string[];
}

export interface TriageRule {
    name: string;
    when: TriageConditions;
    actions: TriageActions;
}

export interface TriageRuleSet {
    version: 1;
    rules: TriageRule[];
}

/**
 * Split a From header into display name, address and domain.
 *
 * Deliberately tolerant: a header this cannot parse yields empty strings rather
 * than throwing, because one malformed sender must not abort a run over a
 * hundred messages.
 */
export function parseSender(fromHeader: string): NormalizedSender {
    const raw = (fromHeader || '').trim();
    const angled = raw.match(/<([^>]*)>\s*$/);
    const email = (angled ? angled[1] : raw).trim().toLowerCase();
    let name = angled ? raw.slice(0, angled.index).trim() : '';
    // Strip the quotes RFC 5322 puts around a display name containing commas.
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1);
    }
    const at = email.lastIndexOf('@');
    // An address with nothing after the @ has no domain to match on, and an
    // empty domain must not be allowed to satisfy a fromDomain rule.
    const domain = at >= 0 ? email.slice(at + 1) : '';
    return { name, email: at > 0 ? email : '', domain };
}

/** Turn a Gmail metadata-format message into the object rules are evaluated against. */
export function normalizeMessage(
    message: any,
    labelNamesById: Map<string, string> = new Map(),
): NormalizedMessage {
    const headers = message?.payload?.headers || [];
    const getHeader = (name: string) =>
        headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const labelIds: string[] = message?.labelIds || [];

    return {
        id: message?.id || '',
        threadId: message?.threadId || '',
        from: parseSender(getHeader('from')),
        subject: getHeader('subject'),
        // internalDate is epoch millis and is the only timestamp Gmail
        // guarantees; the Date header is whatever the sender claimed.
        receivedAt: message?.internalDate
            ? new Date(Number(message.internalDate)).toISOString()
            : getHeader('date'),
        labelIds,
        labelNames: labelIds.map(id => labelNamesById.get(id) ?? id),
        listId: getHeader('list-id').toLowerCase(),
        hasListUnsubscribe: Boolean(getHeader('list-unsubscribe')),
    };
}

const includesCI = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.trim().toLowerCase());

const hasLabelNamed = (message: NormalizedMessage, name: string) =>
    message.labelNames.some(label => label.toLowerCase() === name.trim().toLowerCase());

/** Match `domain` itself or any subdomain of it, never a mere suffix (`notahrefs.com`). */
export function domainMatches(senderDomain: string, ruleDomain: string): boolean {
    const target = ruleDomain.trim().toLowerCase().replace(/^@/, '');
    if (!target || !senderDomain) return false;
    return senderDomain === target || senderDomain.endsWith(`.${target}`);
}

export function ruleMatches(message: NormalizedMessage, rule: TriageRule): boolean {
    const when = rule.when || {};
    const checks: boolean[] = [];

    if (when.fromEquals?.length) {
        checks.push(when.fromEquals.some(value =>
            value.trim().toLowerCase() === message.from.email && message.from.email !== ''));
    }
    if (when.fromDomain?.length) {
        checks.push(when.fromDomain.some(value => domainMatches(message.from.domain, value)));
    }
    if (when.fromContains?.length) {
        const sender = `${message.from.name} ${message.from.email}`;
        checks.push(when.fromContains.some(value => includesCI(sender, value)));
    }
    if (when.subjectContains?.length) {
        checks.push(when.subjectContains.some(value => includesCI(message.subject, value)));
    }
    if (when.listIdContains?.length) {
        checks.push(message.listId !== ''
            && when.listIdContains.some(value => includesCI(message.listId, value)));
    }
    if (when.hasListUnsubscribe !== undefined) {
        checks.push(message.hasListUnsubscribe === when.hasListUnsubscribe);
    }
    if (when.hasLabel?.length) {
        checks.push(when.hasLabel.some(value => hasLabelNamed(message, value)));
    }
    if (when.lacksLabel?.length) {
        // Every named label must be absent — "lacks A or B" would be satisfied
        // by a message carrying A, which is not what the name promises.
        checks.push(when.lacksLabel.every(value => !hasLabelNamed(message, value)));
    }

    // No conditions => no match. See TriageConditions.
    if (checks.length === 0) return false;
    return checks.every(Boolean);
}

/** First matching rule wins, so order in the rule set is the precedence order. */
export function matchHardRules(message: NormalizedMessage, rules: TriageRule[]): TriageRule | undefined {
    return rules.find(rule => ruleMatches(message, rule));
}

/**
 * Strip anything a rule is not allowed to express, and apply shadow mode.
 *
 * Rules come from a config file or a tool argument, so they are as untrusted as
 * anything else a model can write. Passing every rule through here is what
 * makes "labels only, nothing irreversible" an invariant rather than a promise.
 */
export function sanitizeActions(actions: TriageActions, shadowMode = false): TriageActions {
    const clean = (values: string[] | undefined) =>
        (values || []).map(value => String(value).trim()).filter(value => value !== '');

    return {
        addLabels: clean(actions?.addLabels),
        removeLabels: clean(actions?.removeLabels),
        // Shadow mode is the safe way to try a new rule set: it produces the
        // same labels and the same run record, but never moves mail out of the
        // inbox, so a wrong rule is a stray label rather than a lost message.
        archive: shadowMode ? false : Boolean(actions?.archive),
        markRead: shadowMode ? false : Boolean(actions?.markRead),
    };
}

export const MAX_RULES = 200;

/**
 * Reject a rule set before it is stored or applied.
 *
 * Returns every problem rather than throwing on the first, so someone fixing a
 * hand-written file sees the whole list at once.
 */
export function validateRuleSet(ruleSet: TriageRuleSet): string[] {
    const problems: string[] = [];
    if (!Array.isArray(ruleSet?.rules)) {
        return ['rules must be an array'];
    }
    if (ruleSet.rules.length > MAX_RULES) {
        problems.push(`rule set exceeds ${MAX_RULES} rules`);
    }

    const seen = new Set<string>();
    ruleSet.rules.forEach((rule, index) => {
        const label = rule?.name ? `"${rule.name}"` : `#${index}`;
        if (!rule?.name?.trim()) {
            problems.push(`rule ${label} has no name`);
        } else if (seen.has(rule.name)) {
            problems.push(`duplicate rule name "${rule.name}"`);
        } else {
            seen.add(rule.name);
        }

        const when = rule?.when ?? {};
        const conditionCount = Object.entries(when).filter(([, value]) =>
            typeof value === 'boolean' || (Array.isArray(value) && value.length > 0)).length;
        if (conditionCount === 0) {
            problems.push(`rule ${label} has no conditions and would never match`);
        }

        const actions = rule?.actions;
        const actionCount = (actions?.addLabels?.length ?? 0)
            + (actions?.removeLabels?.length ?? 0)
            + (actions?.archive ? 1 : 0)
            + (actions?.markRead ? 1 : 0);
        if (actionCount === 0) {
            problems.push(`rule ${label} has no actions`);
        }
    });

    return problems;
}

/**
 * Load the stored rule set.
 *
 * A missing file is the normal first-run state and yields an empty set. A
 * corrupt or invalid one throws: sorting mail with rules the user believes are
 * in place but which failed to load is worse than stopping.
 */
export function loadRuleSet(filePath: string): TriageRuleSet {
    if (!fs.existsSync(filePath)) return { version: 1, rules: [] };

    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error: any) {
        throw new Error(`Triage rules at ${path.basename(filePath)} are not valid JSON: ${error.message}`);
    }

    const ruleSet: TriageRuleSet = { version: 1, rules: Array.isArray(parsed?.rules) ? parsed.rules : [] };
    const problems = validateRuleSet(ruleSet);
    if (problems.length > 0) {
        throw new Error(`Stored triage rules are invalid: ${problems.join('; ')}`);
    }
    return ruleSet;
}
