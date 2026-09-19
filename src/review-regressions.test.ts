import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEmailMessage, encodeBodyPart } from './utl.js';
import { parseCharset, decodePartBody, GmailMessagePart } from './mime-utils.js';
import { mapWithConcurrency, processItemsIndividually } from './batch-utils.js';
import {
    toMcpTools,
    toolDefinitions,
    DownloadAttachmentSchema,
    SendEmailSchema,
    ForwardEmailSchema,
    InlineImageSchema,
} from './tools.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

// Regressions found by review of this PR. Each test pins the exact behaviour
// that was wrong, so a revert fails loudly rather than silently.

describe('header line length', () => {
    const base = { to: ['a@example.com'], body: 'b' };

    it('folds a maximal ASCII subject', () => {
        // The 998 cap is on the LINE, and `Subject: ` is 9 more characters, so
        // a 998-character subject shipped a 1007-character line. The encoder
        // only folded non-ASCII values, so nothing caught it.
        const message = createEmailMessage({ ...base, subject: 'x '.repeat(600) });
        for (const line of message.split('\r\n')) {
            expect(line.length).toBeLessThanOrEqual(998);
        }
    });

    it('folds a long recipient list', () => {
        // 100 recipients × up to 320 characters is several thousand on one line.
        const to = Array.from({ length: 100 }, (_, i) => `user${i}.longish.name@subdomain.example.com`);
        const message = createEmailMessage({ to, subject: 's', body: 'b' });
        for (const line of message.split('\r\n')) {
            expect(line.length).toBeLessThanOrEqual(998);
        }
        // Folding must not lose a recipient.
        const header = message.split('\r\nMIME-Version')[0];
        for (const address of to) {
            expect(header).toContain(address);
        }
    });

    it('keeps every encoded-word line within the RFC 2047 76-character limit', () => {
        const message = createEmailMessage({ ...base, subject: '主旨'.repeat(60) });
        const lines = message.split('\r\n');
        const start = lines.findIndex(l => l.startsWith('Subject:'));
        let i = start;
        do {
            expect(lines[i].length).toBeLessThanOrEqual(76);
            i += 1;
        } while (lines[i].startsWith(' '));
    });

    it('omits the To: header entirely for a cc-only send', () => {
        const message = createEmailMessage({ to: [], cc: ['c@example.com'], subject: 's', body: 'b' });
        expect(message).not.toMatch(/^To:\s*$/m);
        expect(message).toContain('Cc: c@example.com');
    });
});

describe('7bit honesty', () => {
    it('does not declare 7bit for a body containing C0 controls', () => {
        // An ASCII-range check alone lets NUL through, and RFC 2045 forbids it
        // in a 7bit body.
        expect(encodeBodyPart('a\u0000b').encoding).toBe('base64');
        expect(encodeBodyPart('a\u0007b').encoding).toBe('base64');
    });

    it('normalises bare LF to CRLF in the 7bit branch', () => {
        // The message is assembled with CRLF separators, so a body carrying
        // bare LF leaves mixed line endings inside the part.
        const { encoding, body } = encodeBodyPart('line1\nline2\r\nline3\rline4');
        expect(encoding).toBe('7bit');
        expect(body).toBe('line1\r\nline2\r\nline3\r\nline4');
    });

    it('still keeps tabs and ordinary text as 7bit', () => {
        expect(encodeBodyPart('a\tb').encoding).toBe('7bit');
    });
});

describe('charset parameter parsing', () => {
    it('ignores a charset hidden inside a quoted parameter value', () => {
        // The Content-Type of an inbound part is chosen by the SENDER, so a
        // regex that took the first `charset=` in the header could be steered
        // into decoding a UTF-8 body as UTF-16LE.
        expect(parseCharset('text/plain; name="a; charset=utf-16le; b"; charset=utf-8')).toBe('utf-8');
        expect(parseCharset('text/plain; name="report; charset=utf-16le "; charset=big5')).toBe('big5');
        expect(parseCharset('text/plain; name="x; charset=evil"')).toBeUndefined();
    });

    it('decodes the body with the real charset', () => {
        const part: GmailMessagePart = {
            mimeType: 'text/plain',
            headers: [{
                name: 'Content-Type',
                value: 'text/plain; name="a; charset=utf-16le; b"; charset=utf-8',
            }],
            body: { data: Buffer.from('中文內容', 'utf8').toString('base64url') },
        };
        expect(decodePartBody(part)).toBe('中文內容');
    });

    it('still reads a plain charset parameter', () => {
        expect(parseCharset('text/plain; charset=Big5')).toBe('big5');
        expect(parseCharset('text/plain; charset="ISO-8859-1"; format=flowed')).toBe('iso-8859-1');
    });
});

describe('concurrency abort', () => {
    it('stops dispatching after the first failure', async () => {
        // Promise.all rejects on the first failure but never signals the other
        // workers, so they drained the whole list in the background — on a 429
        // that meant the remaining requests of a 500-hit page still went out.
        let invoked = 0;
        await expect(
            mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 5, async (n) => {
                invoked += 1;
                await new Promise(resolve => setTimeout(resolve, 2));
                if (n === 3) throw new Error('429 rateLimitExceeded');
                return n;
            }),
        ).rejects.toThrow('429');

        const atRejection = invoked;
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(invoked).toBe(atRejection);
        expect(invoked).toBeLessThan(40);
    });

    it('keeps successes when processItem throws synchronously', async () => {
        const { successes, failures } = await processItemsIndividually(
            ['a', 'b', 'c', 'd'],
            2,
            (item) => {
                if (item === 'c') throw new Error('sync boom');
                return Promise.resolve();
            },
        );
        expect(successes).toEqual(['a', 'b', 'd']);
        expect(failures.map(f => f.item)).toEqual(['c']);
    });
});

describe('schema bounds that were too tight', () => {
    it('accepts a real Gmail attachment id', () => {
        // Gmail attachment IDs are long base64url blobs; a 512-character cap
        // made download_attachment unusable for the large attachments it exists
        // to fetch — the ones read_email surfaces the id for.
        const id = 'ANGjdJ_' + 'x'.repeat(600);
        expect(DownloadAttachmentSchema.safeParse({ messageId: 'm1', attachmentId: id }).success).toBe(true);
    });

    it('accepts a cc-only and a bcc-only send', () => {
        expect(SendEmailSchema.safeParse({ to: [], cc: ['c@example.com'], subject: 's', body: 'b' }).success).toBe(true);
        expect(SendEmailSchema.safeParse({ to: [], bcc: ['b@example.com'], subject: 's', body: 'b' }).success).toBe(true);
        expect(ForwardEmailSchema.safeParse({ messageId: 'm1', bcc: ['b@example.com'] }).success).toBe(true);
    });

    it('still requires a recipient somewhere', () => {
        expect(SendEmailSchema.safeParse({ to: [], subject: 's', body: 'b' }).success).toBe(false);
        expect(ForwardEmailSchema.safeParse({ messageId: 'm1' }).success).toBe(false);
    });

    it('accepts an inline image up to the documented 10 MiB decoded', () => {
        // `content` is base64: bounding the STRING at 10 MiB capped decoded
        // images at 7.5 MiB and made the decoded-size guard unreachable.
        const content = 'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4);
        expect(InlineImageSchema.safeParse({ cid: 'x', content, contentType: 'image/png' }).success).toBe(true);
    });
});

describe('MCP tool schema emission', () => {
    it('emits no $ref, so every field keeps its own description', () => {
        // Sharing a zod instance across fields makes zodToJsonSchema
        // deduplicate by identity and emit `$ref`. Draft-07 requires keywords
        // beside a `$ref` to be ignored, so the per-field description was
        // dropped and the model read the target's — `removeLabelIds`
        // documented itself as "label IDs to apply".
        const tools = toMcpTools(toolDefinitions);
        expect(JSON.stringify(tools)).not.toContain('"$ref"');
    });

    it('describes add and remove label lists distinctly', () => {
        const tools = toMcpTools(toolDefinitions);
        const modify = tools.find(t => t.name === 'modify_email')!;
        const properties = (modify.inputSchema as any).properties;
        expect(properties.addLabelIds.description).toMatch(/add/i);
        expect(properties.removeLabelIds.description).toMatch(/remove/i);

        const forward = tools.find(t => t.name === 'forward_email')!;
        expect((forward.inputSchema as any).properties.bcc.description).toMatch(/BCC/i);
    });
});

describe('.eml byte fidelity', () => {
    it('round-trips bytes that a UTF-8 string round-trip would corrupt', () => {
        // A raw RFC822 message carries 8-bit attachment payloads and Latin-1
        // headers. Decoding it to a string and re-encoding replaced every
        // invalid sequence with U+FFFD, so the saved .eml's attachments no
        // longer opened.
        const raw = Buffer.from([0x53, 0x75, 0x62, 0x6a, 0x3a, 0x20, 0xe9, 0xff, 0xfe, 0x00, 0x80]);
        const encoded = raw.toString('base64url');

        const asBuffer = Buffer.from(encoded, 'base64url');
        expect(asBuffer.equals(raw)).toBe(true);

        const asString = Buffer.from(Buffer.from(encoded, 'base64url').toString('utf-8'), 'utf-8');
        expect(asString.equals(raw)).toBe(false);
    });

    it('download_email writes the eml branch as raw bytes', () => {
        const source = fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf8');
        expect(source).toContain('Buffer.isBuffer(content)');
        expect(source).not.toMatch(/rawResponse\.data\.raw[^\n]*toString\("utf-8"\)/);
    });
});
