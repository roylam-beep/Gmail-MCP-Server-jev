import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    parseSender,
    normalizeMessage,
    domainMatches,
    ruleMatches,
    matchHardRules,
    sanitizeActions,
    validateRuleSet,
    loadRuleSet,
    NormalizedMessage,
    TriageRule,
} from './triage-rules.js';

const message = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
    id: 'm1',
    threadId: 't1',
    from: { name: 'Ahrefs', email: 'sa@ahrefs.com', domain: 'ahrefs.com' },
    subject: 'Site audit finished',
    receivedAt: '2026-09-19T00:00:00.000Z',
    labelIds: ['INBOX'],
    labelNames: ['INBOX'],
    listId: '',
    hasListUnsubscribe: false,
    ...overrides,
});

const rule = (when: TriageRule['when']): TriageRule => ({
    name: 'r',
    when,
    actions: { addLabels: ['X'] },
});

describe('parseSender', () => {
    it('splits an angle-addressed header', () => {
        expect(parseSender('Ahrefs Alerts <sa@Ahrefs.com>')).toEqual({
            name: 'Ahrefs Alerts',
            email: 'sa@ahrefs.com',
            domain: 'ahrefs.com',
        });
    });

    it('handles a bare address', () => {
        expect(parseSender('billing@meta.com')).toEqual({
            name: '',
            email: 'billing@meta.com',
            domain: 'meta.com',
        });
    });

    it('strips the quotes around a display name containing a comma', () => {
        expect(parseSender('"Lam, Roy" <roy@example.com>').name).toBe('Lam, Roy');
    });

    it('yields empty strings rather than throwing on a malformed header', () => {
        // One unparseable sender must not abort a run over a hundred messages.
        expect(parseSender('')).toEqual({ name: '', email: '', domain: '' });
        expect(parseSender('not an address')).toEqual({ name: '', email: '', domain: '' });
    });

    it('treats an address with no local part as having no address', () => {
        expect(parseSender('<@example.com>').email).toBe('');
    });
});

describe('normalizeMessage', () => {
    it('reads headers case-insensitively and resolves label names', () => {
        const normalized = normalizeMessage(
            {
                id: 'abc',
                threadId: 'thr',
                internalDate: '1758240000000',
                labelIds: ['INBOX', 'Label_7'],
                payload: {
                    headers: [
                        { name: 'FROM', value: 'News <news@example.com>' },
                        { name: 'subject', value: 'Weekly digest' },
                        { name: 'List-Id', value: '<Digest.EXAMPLE.com>' },
                        { name: 'List-Unsubscribe', value: '<mailto:x@example.com>' },
                    ],
                },
            },
            new Map([['Label_7', 'Newsletters']]),
        );

        expect(normalized.from.email).toBe('news@example.com');
        expect(normalized.subject).toBe('Weekly digest');
        expect(normalized.listId).toBe('<digest.example.com>');
        expect(normalized.hasListUnsubscribe).toBe(true);
        expect(normalized.labelNames).toEqual(['INBOX', 'Newsletters']);
        expect(normalized.receivedAt).toBe(new Date(1758240000000).toISOString());
    });

    it('survives a message with no payload at all', () => {
        const normalized = normalizeMessage({ id: 'x' });
        expect(normalized.subject).toBe('');
        expect(normalized.hasListUnsubscribe).toBe(false);
    });
});

describe('domainMatches', () => {
    it('matches the domain and its subdomains', () => {
        expect(domainMatches('ahrefs.com', 'ahrefs.com')).toBe(true);
        expect(domainMatches('mail.ahrefs.com', 'ahrefs.com')).toBe(true);
        expect(domainMatches('ahrefs.com', '@ahrefs.com')).toBe(true);
    });

    it('does not match a mere suffix', () => {
        // The whole point of the leading-dot check: notahrefs.com is a
        // different company, and a lookalike domain is how phishing arrives.
        expect(domainMatches('notahrefs.com', 'ahrefs.com')).toBe(false);
    });

    it('never matches an empty domain', () => {
        expect(domainMatches('', 'ahrefs.com')).toBe(false);
        expect(domainMatches('ahrefs.com', '')).toBe(false);
    });
});

describe('ruleMatches', () => {
    it('ORs values within a field', () => {
        const r = rule({ fromEquals: ['other@x.com', 'sa@ahrefs.com'] });
        expect(ruleMatches(message(), r)).toBe(true);
    });

    it('ANDs across fields', () => {
        const r = rule({ fromDomain: ['ahrefs.com'], subjectContains: ['invoice'] });
        expect(ruleMatches(message(), r)).toBe(false);
        expect(ruleMatches(message({ subject: 'Your invoice' }), r)).toBe(true);
    });

    it('never matches a rule with no conditions', () => {
        // A half-written rule must not become a catch-all that relabels the
        // entire mailbox.
        expect(ruleMatches(message(), rule({}))).toBe(false);
    });

    it('matches List-Id but not an empty one', () => {
        const r = rule({ listIdContains: ['digest.example.com'] });
        expect(ruleMatches(message({ listId: '<digest.example.com>' }), r)).toBe(true);
        expect(ruleMatches(message({ listId: '' }), r)).toBe(false);
    });

    it('matches hasListUnsubscribe in both directions', () => {
        expect(ruleMatches(message({ hasListUnsubscribe: true }), rule({ hasListUnsubscribe: true }))).toBe(true);
        expect(ruleMatches(message({ hasListUnsubscribe: false }), rule({ hasListUnsubscribe: false }))).toBe(true);
        expect(ruleMatches(message({ hasListUnsubscribe: false }), rule({ hasListUnsubscribe: true }))).toBe(false);
    });

    it('requires every lacksLabel to be absent', () => {
        // "lacks A or B" would be satisfied by a message carrying A, which is
        // not what the field name promises.
        const r = rule({ lacksLabel: ['Done', 'Sorted'] });
        expect(ruleMatches(message({ labelNames: ['INBOX'] }), r)).toBe(true);
        expect(ruleMatches(message({ labelNames: ['INBOX', 'Done'] }), r)).toBe(false);
    });

    it('does not let an unparseable sender satisfy fromEquals', () => {
        const blank = message({ from: { name: '', email: '', domain: '' } });
        expect(ruleMatches(blank, rule({ fromEquals: [''] }))).toBe(false);
    });
});

describe('matchHardRules', () => {
    it('returns the first matching rule, so order is precedence', () => {
        const rules: TriageRule[] = [
            { name: 'specific', when: { fromEquals: ['sa@ahrefs.com'] }, actions: { addLabels: ['A'] } },
            { name: 'broad', when: { fromDomain: ['ahrefs.com'] }, actions: { addLabels: ['B'] } },
        ];
        expect(matchHardRules(message(), rules)?.name).toBe('specific');
    });

    it('returns undefined when nothing matches', () => {
        expect(matchHardRules(message(), [rule({ fromDomain: ['nope.com'] })])).toBeUndefined();
    });
});

describe('sanitizeActions', () => {
    it('drops archive and markRead in shadow mode', () => {
        const actions = sanitizeActions({ addLabels: ['A'], archive: true, markRead: true }, true);
        expect(actions).toEqual({ addLabels: ['A'], removeLabels: [], archive: false, markRead: false });
    });

    it('keeps them when not in shadow mode', () => {
        const actions = sanitizeActions({ addLabels: ['A'], archive: true }, false);
        expect(actions.archive).toBe(true);
    });

    it('trims and drops empty label names', () => {
        expect(sanitizeActions({ addLabels: [' A ', '', '   '] }).addLabels).toEqual(['A']);
    });

    it('tolerates a rule with no actions object', () => {
        expect(sanitizeActions({} as any).addLabels).toEqual([]);
    });
});

describe('validateRuleSet', () => {
    it('accepts a well-formed set', () => {
        expect(validateRuleSet({
            version: 1,
            rules: [{ name: 'a', when: { fromDomain: ['x.com'] }, actions: { addLabels: ['L'] } }],
        })).toEqual([]);
    });

    it('reports every problem rather than the first', () => {
        const problems = validateRuleSet({
            version: 1,
            rules: [
                { name: '', when: {}, actions: { addLabels: [] } },
                { name: 'dup', when: { fromDomain: ['x.com'] }, actions: { addLabels: ['L'] } },
                { name: 'dup', when: { fromDomain: ['y.com'] }, actions: { addLabels: ['L'] } },
            ],
        });
        expect(problems).toHaveLength(4); // no name, no conditions, no actions, duplicate
        expect(problems.some(p => p.includes('no conditions'))).toBe(true);
        expect(problems.some(p => p.includes('duplicate'))).toBe(true);
    });

    it('counts a boolean condition as a condition', () => {
        expect(validateRuleSet({
            version: 1,
            rules: [{ name: 'bulk', when: { hasListUnsubscribe: true }, actions: { archive: true, addLabels: [] } }],
        })).toEqual([]);
    });

    it('rejects a non-array rules field', () => {
        expect(validateRuleSet({ version: 1, rules: 'nope' } as any)).toEqual(['rules must be an array']);
    });
});

describe('loadRuleSet', () => {
    const tempFile = (contents?: string) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-rules-'));
        const file = path.join(dir, 'triage-rules.json');
        if (contents !== undefined) fs.writeFileSync(file, contents);
        return file;
    };

    it('treats a missing file as an empty set', () => {
        expect(loadRuleSet(tempFile())).toEqual({ version: 1, rules: [] });
    });

    it('throws on malformed JSON rather than sorting with no rules', () => {
        // Silently sorting mail with rules the user believes are in place is
        // worse than stopping.
        expect(() => loadRuleSet(tempFile('{ not json'))).toThrow(/not valid JSON/);
    });

    it('throws when the stored rules are semantically invalid', () => {
        const file = tempFile(JSON.stringify({ rules: [{ name: 'x', when: {}, actions: { addLabels: ['L'] } }] }));
        expect(() => loadRuleSet(file)).toThrow(/no conditions/);
    });

    it('round-trips a valid set', () => {
        const rules = [{ name: 'x', when: { fromDomain: ['a.com'] }, actions: { addLabels: ['L'] } }];
        expect(loadRuleSet(tempFile(JSON.stringify({ version: 1, rules }))).rules).toEqual(rules);
    });
});
