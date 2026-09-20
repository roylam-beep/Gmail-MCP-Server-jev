import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    runIdIsSafe,
    runFilePath,
    saveRun,
    loadRun,
    listRuns,
    pruneRuns,
    planTriage,
    applyRun,
    rollbackRun,
    summarizeRun,
    TriageRun,
} from './triage-manager.js';
import type { TriageRule } from './triage-rules.js';

let runsDir: string;

beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-runs-'));
});

interface FakeMessage {
    id: string;
    from: string;
    subject: string;
    labelIds?: string[];
    listUnsubscribe?: boolean;
}

/** Minimal stand-in for the googleapis gmail client, recording every call. */
function fakeGmail(messages: FakeMessage[], options: { existingLabels?: Array<{ id: string; name: string }> } = {}) {
    const modifyCalls: Array<{ id: string; addLabelIds: string[]; removeLabelIds: string[] }> = [];
    const getCalls: Array<{ id: string; format: string; metadataHeaders?: string[] }> = [];
    const createdLabels: string[] = [];
    const labels = [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        ...(options.existingLabels ?? []).map(label => ({ ...label, type: 'user' })),
    ];

    const gmail = {
        users: {
            messages: {
                list: async () => ({ data: { messages: messages.map(m => ({ id: m.id })) } }),
                get: async ({ id, format, metadataHeaders }: any) => {
                    getCalls.push({ id, format, metadataHeaders });
                    const found = messages.find(m => m.id === id);
                    if (!found) throw new Error('not found');
                    const headers = [
                        { name: 'From', value: found.from },
                        { name: 'Subject', value: found.subject },
                    ];
                    if (found.listUnsubscribe) headers.push({ name: 'List-Unsubscribe', value: '<mailto:x@y.com>' });
                    return {
                        data: {
                            id: found.id,
                            threadId: `t-${found.id}`,
                            internalDate: '1758240000000',
                            labelIds: found.labelIds ?? ['INBOX'],
                            payload: { headers },
                        },
                    };
                },
                modify: async ({ id, requestBody }: any) => {
                    modifyCalls.push({
                        id,
                        addLabelIds: requestBody.addLabelIds ?? [],
                        removeLabelIds: requestBody.removeLabelIds ?? [],
                    });
                    return {};
                },
            },
            labels: {
                list: async () => ({ data: { labels } }),
                create: async ({ requestBody }: any) => {
                    createdLabels.push(requestBody.name);
                    const created = { id: `Label_${labels.length}`, name: requestBody.name, type: 'user' };
                    labels.push(created);
                    return { data: created };
                },
            },
        },
    };

    return { gmail, modifyCalls, getCalls, createdLabels };
}

const ahrefsRule: TriageRule = {
    name: 'ahrefs',
    when: { fromDomain: ['ahrefs.com'] },
    actions: { addLabels: ['Ahrefs/Audits'], archive: true },
};

describe('runIdIsSafe', () => {
    it('accepts a generated id', () => {
        expect(runIdIsSafe('run-2026-09-19T00-00-00-000Z-a1b2c3')).toBe(true);
    });

    it('rejects path traversal and hidden files', () => {
        // Run ids arrive as tool arguments and become a filename.
        expect(runIdIsSafe('../../etc/passwd')).toBe(false);
        expect(runIdIsSafe('a/b')).toBe(false);
        expect(runIdIsSafe('.hidden')).toBe(false);
        expect(runIdIsSafe('..')).toBe(false);
        expect(runIdIsSafe('')).toBe(false);
    });

    it('is enforced by runFilePath', () => {
        expect(() => runFilePath('/tmp', '../escape')).toThrow(/Invalid run id/);
    });
});

describe('run persistence', () => {
    const makeRun = (runId: string): TriageRun => ({
        version: 1,
        runId,
        createdAt: new Date().toISOString(),
        query: 'in:inbox',
        shadowMode: false,
        unmatched: 0,
        items: [],
    });

    it('round-trips a run', () => {
        saveRun(runsDir, makeRun('run-a'));
        expect(loadRun(runsDir, 'run-a').runId).toBe('run-a');
    });

    it('writes the run file owner-only', () => {
        const filePath = saveRun(runsDir, makeRun('run-b'));
        // Run files carry subjects and sender addresses for real mail.
        if (process.platform !== 'win32') {
            expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        }
    });

    it('explains itself when the run is missing', () => {
        expect(() => loadRun(runsDir, 'run-nope')).toThrow(/not found/);
    });

    it('prunes the oldest runs beyond the keep count', () => {
        for (const id of ['run-1', 'run-2', 'run-3']) saveRun(runsDir, makeRun(id));
        expect(pruneRuns(runsDir, 2)).toBe(1);
        expect(listRuns(runsDir).length).toBe(2);
    });

    it('lists nothing for a directory that does not exist', () => {
        expect(listRuns(path.join(runsDir, 'missing'))).toEqual([]);
    });
});

describe('planTriage', () => {
    it('fetches headers only — never a message body', async () => {
        // This is the privacy guarantee of the whole feature, so it is asserted
        // rather than left to the reader of the source.
        const { gmail, getCalls } = fakeGmail([
            { id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' },
        ]);

        await planTriage(gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });

        expect(getCalls.every(call => call.format === 'metadata')).toBe(true);
        expect(getCalls[0].metadataHeaders).toContain('List-Id');
    });

    it('matches rules and counts what nothing claimed', async () => {
        const { gmail } = fakeGmail([
            { id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' },
            { id: 'm2', from: 'client@acme.com', subject: 'Project update' },
        ]);

        const run = await planTriage(gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });

        expect(run.items).toHaveLength(1);
        expect(run.items[0].ruleName).toBe('ahrefs');
        expect(run.unmatched).toBe(1);
        expect(summarizeRun(run).byRule).toEqual({ ahrefs: 1 });
    });

    it('lists unmatched messages with no action when asked', async () => {
        const { gmail } = fakeGmail([{ id: 'm2', from: 'client@acme.com', subject: 'Hi' }]);

        const run = await planTriage(gmail, runsDir, {
            query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule], includeUnmatched: true,
        });

        expect(run.items).toHaveLength(1);
        expect(run.items[0].ruleName).toBeUndefined();
        expect(run.items[0].actions.addLabels).toEqual([]);
    });

    it('drops archive in shadow mode', async () => {
        const { gmail } = fakeGmail([{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }]);

        const run = await planTriage(gmail, runsDir, {
            query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule], shadowMode: true,
        });

        expect(run.items[0].actions.archive).toBe(false);
        expect(run.items[0].actions.addLabels).toEqual(['Ahrefs/Audits']);
    });

    it('keeps going when one message disappears between list and get', async () => {
        const { gmail } = fakeGmail([{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }]);
        // list reports a message that get will 404 on.
        gmail.users.messages.list = async () => ({ data: { messages: [{ id: 'm1' }, { id: 'gone' }] } }) as any;

        const run = await planTriage(gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });

        expect(run.items).toHaveLength(1);
    });

    it('truncates an overlong subject', async () => {
        const { gmail } = fakeGmail([{ id: 'm1', from: 'sa@ahrefs.com', subject: 'x'.repeat(500) }]);
        const run = await planTriage(gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });
        expect(run.items[0].subject).toHaveLength(200);
    });
});

describe('applyRun', () => {
    const planned = async (rules: TriageRule[] = [ahrefsRule], messages?: FakeMessage[]) => {
        const fake = fakeGmail(messages ?? [{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }]);
        const run = await planTriage(fake.gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules });
        return { ...fake, run };
    };

    it('creates the missing label, maps INBOX to a removal, and records the delta', async () => {
        const { gmail, modifyCalls, createdLabels, run } = await planned();

        const result = await applyRun(gmail, runsDir, run);

        expect(createdLabels).toEqual(['Ahrefs/Audits']);
        expect(modifyCalls).toHaveLength(1);
        expect(modifyCalls[0].removeLabelIds).toContain('INBOX');
        expect(result.applied).toBe(1);
        // The delta is what rollback reverses, so it must be persisted.
        expect(loadRun(runsDir, run.runId).items[0].applied?.removedLabelIds).toContain('INBOX');
    });

    it('never tries to create a Gmail system label', async () => {
        const rules: TriageRule[] = [{
            name: 'star', when: { fromDomain: ['ahrefs.com'] }, actions: { addLabels: ['STARRED'] },
        }];
        const { gmail, createdLabels, modifyCalls, run } = await planned(rules);

        await applyRun(gmail, runsDir, run);

        expect(createdLabels).toEqual([]);
        expect(modifyCalls[0].addLabelIds).toEqual(['STARRED']);
    });

    it('reuses an existing label instead of creating a duplicate', async () => {
        const fake = fakeGmail(
            [{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }],
            { existingLabels: [{ id: 'Label_9', name: 'Ahrefs/Audits' }] },
        );
        const run = await planTriage(fake.gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });

        await applyRun(fake.gmail, runsDir, run);

        expect(fake.createdLabels).toEqual([]);
        expect(fake.modifyCalls[0].addLabelIds).toEqual(['Label_9']);
    });

    it('changes nothing on a dry run', async () => {
        const { gmail, modifyCalls, createdLabels, run } = await planned();

        const result = await applyRun(gmail, runsDir, run, { dryRun: true });

        expect(modifyCalls).toEqual([]);
        expect(createdLabels).toEqual([]);
        expect(result.applied).toBe(0);
    });

    it('applies only the named rules', async () => {
        const rules: TriageRule[] = [
            ahrefsRule,
            { name: 'acme', when: { fromDomain: ['acme.com'] }, actions: { addLabels: ['Clients'] } },
        ];
        const { gmail, modifyCalls, run } = await planned(rules, [
            { id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit' },
            { id: 'm2', from: 'client@acme.com', subject: 'Update' },
        ]);

        const result = await applyRun(gmail, runsDir, run, { onlyRules: ['acme'] });

        expect(modifyCalls.map(call => call.id)).toEqual(['m2']);
        expect(result.skipped).toBe(1);
    });

    it('does not re-apply an item that already succeeded', async () => {
        const { gmail, modifyCalls, run } = await planned();

        await applyRun(gmail, runsDir, run);
        const second = await applyRun(gmail, runsDir, run);

        expect(modifyCalls).toHaveLength(1);
        expect(second.applied).toBe(0);
    });

    it('reports a per-message failure without losing its siblings', async () => {
        const { gmail, run } = await planned(undefined, [
            { id: 'm1', from: 'sa@ahrefs.com', subject: 'One' },
            { id: 'm2', from: 'sa@ahrefs.com', subject: 'Two' },
        ]);
        gmail.users.messages.modify = (async ({ id }: any) => {
            if (id === 'm1') throw new Error('rateLimitExceeded');
            return {};
        }) as any;

        const result = await applyRun(gmail, runsDir, run);

        expect(result.applied).toBe(1);
        expect(result.failures).toEqual([{ messageId: 'm1', error: 'rateLimitExceeded' }]);
    });
});

describe('rollbackRun', () => {
    it('reverses exactly the delta the run issued', async () => {
        const fake = fakeGmail([{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }]);
        const run = await planTriage(fake.gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });
        await applyRun(fake.gmail, runsDir, run);
        const forward = fake.modifyCalls[0];

        const result = await rollbackRun(fake.gmail, runsDir, run);

        const reverse = fake.modifyCalls[1];
        expect(result.reverted).toBe(1);
        // Reversing the delta rather than restoring a snapshot leaves alone
        // anything the user changed on the message in between.
        expect(reverse.addLabelIds).toEqual(forward.removeLabelIds);
        expect(reverse.removeLabelIds).toEqual(forward.addLabelIds);
    });

    it('is a no-op on a run that was never applied', async () => {
        const fake = fakeGmail([{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }]);
        const run = await planTriage(fake.gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });

        expect((await rollbackRun(fake.gmail, runsDir, run)).reverted).toBe(0);
        expect(fake.modifyCalls).toEqual([]);
    });

    it('does not reverse the same run twice', async () => {
        const fake = fakeGmail([{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }]);
        const run = await planTriage(fake.gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });
        await applyRun(fake.gmail, runsDir, run);

        await rollbackRun(fake.gmail, runsDir, run);
        const second = await rollbackRun(fake.gmail, runsDir, run);

        expect(second.reverted).toBe(0);
        expect(fake.modifyCalls).toHaveLength(2);
    });

    it('lets a rolled-back run be applied again', async () => {
        const fake = fakeGmail([{ id: 'm1', from: 'sa@ahrefs.com', subject: 'Audit done' }]);
        const run = await planTriage(fake.gmail, runsDir, { query: 'in:inbox', maxMessages: 10, rules: [ahrefsRule] });
        await applyRun(fake.gmail, runsDir, run);
        await rollbackRun(fake.gmail, runsDir, run);

        const result = await applyRun(fake.gmail, runsDir, run);

        expect(result.applied).toBe(1);
        expect(fake.modifyCalls).toHaveLength(3);
    });
});
