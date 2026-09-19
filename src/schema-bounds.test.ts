import { describe, it, expect } from 'vitest';
import {
    SendEmailSchema,
    SearchEmailsSchema,
    BatchModifyEmailsSchema,
    BatchDeleteEmailsSchema,
    BatchReportPhishingSchema,
    ListInboxThreadsSchema,
    GetInboxWithThreadsSchema,
    ReadEmailSchema,
    ModifyEmailSchema,
    ForwardEmailSchema,
} from './tools.js';

// H2/H3: every externally supplied number, array and string is bounded.
// Unbounded values used to reach loop counters and request fan-out directly.

describe('batchSize bounds', () => {
    const schemas = {
        batch_modify_emails: BatchModifyEmailsSchema,
        batch_delete_emails: BatchDeleteEmailsSchema,
        batch_report_phishing: BatchReportPhishingSchema,
    };

    for (const [name, schema] of Object.entries(schemas)) {
        describe(name, () => {
            // batchSize 0 made `for (i = 0; i < items.length; i += batchSize)`
            // never advance — an infinite loop that hangs the server.
            it('rejects batchSize 0', () => {
                expect(() => schema.parse({ messageIds: ['a'], batchSize: 0 })).toThrow();
            });

            it('rejects negative batchSize', () => {
                expect(() => schema.parse({ messageIds: ['a'], batchSize: -5 })).toThrow();
            });

            it('rejects fractional batchSize', () => {
                expect(() => schema.parse({ messageIds: ['a'], batchSize: 2.5 })).toThrow();
            });

            it('rejects batchSize above the cap', () => {
                expect(() => schema.parse({ messageIds: ['a'], batchSize: 101 })).toThrow();
            });

            it('accepts a batchSize inside the range', () => {
                expect(schema.parse({ messageIds: ['a'], batchSize: 50 }).batchSize).toBe(50);
            });

            it('defaults batchSize to 50', () => {
                expect(schema.parse({ messageIds: ['a'] }).batchSize).toBe(50);
            });

            it('rejects an empty messageIds list', () => {
                expect(() => schema.parse({ messageIds: [] })).toThrow();
            });

            it('rejects more than 1000 message IDs', () => {
                const ids = Array.from({ length: 1001 }, (_, i) => `m${i}`);
                expect(() => schema.parse({ messageIds: ids })).toThrow();
            });

            it('rejects an empty message ID', () => {
                expect(() => schema.parse({ messageIds: [''] })).toThrow();
            });
        });
    }
});

describe('maxResults bounds', () => {
    // A negative maxResults silently returned nothing; an unbounded one paged
    // through the whole mailbox.
    it('search_emails rejects 0, negative, fractional and over-cap values', () => {
        for (const maxResults of [0, -1, 1.5, 501]) {
            expect(() => SearchEmailsSchema.parse({ query: 'x', maxResults })).toThrow();
        }
    });

    it('search_emails accepts 1..500', () => {
        expect(SearchEmailsSchema.parse({ query: 'x', maxResults: 1 }).maxResults).toBe(1);
        expect(SearchEmailsSchema.parse({ query: 'x', maxResults: 500 }).maxResults).toBe(500);
    });

    it('thread listings reject out-of-range maxResults', () => {
        for (const schema of [ListInboxThreadsSchema, GetInboxWithThreadsSchema]) {
            expect(() => schema.parse({ maxResults: 0 })).toThrow();
            expect(() => schema.parse({ maxResults: -10 })).toThrow();
            expect(() => schema.parse({ maxResults: 501 })).toThrow();
            expect(schema.parse({}).maxResults).toBe(50);
        }
    });
});

describe('recipient and id bounds', () => {
    const base = { subject: 's', body: 'b' };

    it('rejects an empty recipient list', () => {
        expect(() => SendEmailSchema.parse({ ...base, to: [] })).toThrow();
    });

    it('rejects more than 100 recipients', () => {
        const to = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
        expect(() => SendEmailSchema.parse({ ...base, to })).toThrow();
    });

    it('rejects an over-long address', () => {
        const to = ['a'.repeat(321) + '@example.com'];
        expect(() => SendEmailSchema.parse({ ...base, to })).toThrow();
    });

    it('rejects an over-long subject', () => {
        expect(() =>
            SendEmailSchema.parse({ ...base, subject: 'x'.repeat(999), to: ['a@example.com'] }),
        ).toThrow();
    });

    it('rejects more than 25 attachments', () => {
        const attachments = Array.from({ length: 26 }, (_, i) => `/tmp/f${i}`);
        expect(() =>
            SendEmailSchema.parse({ ...base, to: ['a@example.com'], attachments }),
        ).toThrow();
    });

    it('accepts a normal send', () => {
        const parsed = SendEmailSchema.parse({ ...base, to: ['a@example.com'] });
        expect(parsed.to).toEqual(['a@example.com']);
    });

    it('rejects empty ids', () => {
        expect(() => ReadEmailSchema.parse({ messageId: '' })).toThrow();
        expect(() => ForwardEmailSchema.parse({ messageId: '', to: ['a@example.com'] })).toThrow();
        expect(() => ForwardEmailSchema.parse({ messageId: 'm1', to: [] })).toThrow();
    });

    it('rejects more than 100 label ids', () => {
        const labelIds = Array.from({ length: 101 }, (_, i) => `L${i}`);
        expect(() => ModifyEmailSchema.parse({ messageId: 'm1', addLabelIds: labelIds })).toThrow();
    });
});
