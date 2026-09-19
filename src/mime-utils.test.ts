import { describe, it, expect } from 'vitest';
import {
    MAX_MIME_DEPTH,
    parseCharset,
    decodePartBody,
    walkParts,
    extractEmailContent,
    extractAttachments,
    findAttachmentFilename,
    GmailMessagePart,
} from './mime-utils.js';
import { collectForwardAttachments, MAX_FORWARD_MIME_DEPTH } from './forward-helpers.js';

const b64url = (text: string, charset: BufferEncoding | 'binary' = 'utf8') =>
    Buffer.from(text, charset as BufferEncoding).toString('base64url');

/** Build a chain of `depth` nested multipart parts with a text leaf. */
function nest(depth: number, leaf: GmailMessagePart): GmailMessagePart {
    let node = leaf;
    for (let i = 0; i < depth; i++) {
        node = { mimeType: 'multipart/mixed', parts: [node] };
    }
    return node;
}

describe('parseCharset', () => {
    it('reads an unquoted charset', () => {
        expect(parseCharset('text/plain; charset=Big5')).toBe('big5');
    });

    it('reads a quoted charset', () => {
        expect(parseCharset('text/plain; charset="ISO-8859-1"')).toBe('iso-8859-1');
        expect(parseCharset("text/plain; charset='shift_jis'")).toBe('shift_jis');
    });

    it('tolerates extra parameters and spacing', () => {
        expect(parseCharset('text/plain;  charset = utf-8 ; format=flowed')).toBe('utf-8');
    });

    it('returns undefined when absent', () => {
        expect(parseCharset('text/plain')).toBeUndefined();
        expect(parseCharset(undefined)).toBeUndefined();
    });
});

describe('decodePartBody', () => {
    it('decodes UTF-8 when no charset is declared', () => {
        const part: GmailMessagePart = { mimeType: 'text/plain', body: { data: b64url('héllo') } };
        expect(decodePartBody(part)).toBe('héllo');
    });

    it('decodes a declared non-UTF-8 charset', () => {
        // M2: the decoder was hardcoded to UTF-8, so a Big5 message came back
        // as mojibake in read_email and in the file download_email wrote.
        const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]); // 中文
        const part: GmailMessagePart = {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset=Big5' }],
            body: { data: big5.toString('base64url') },
        };
        expect(decodePartBody(part)).toBe('中文');
    });

    it('decodes latin-1 correctly rather than as UTF-8', () => {
        const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // café
        const part: GmailMessagePart = {
            mimeType: 'text/plain',
            headers: [{ name: 'content-type', value: 'text/plain; charset=iso-8859-1' }],
            body: { data: latin1.toString('base64url') },
        };
        expect(decodePartBody(part)).toBe('café');
        // Decoded as UTF-8 the same bytes produce a replacement character.
        expect(latin1.toString('utf8')).not.toBe('café');
    });

    it('falls back to UTF-8 for an unknown charset label', () => {
        const part: GmailMessagePart = {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset=x-not-a-charset' }],
            body: { data: b64url('plain') },
        };
        expect(decodePartBody(part)).toBe('plain');
    });

    it('decodes base64url payloads containing - and _', () => {
        const bytes = Buffer.from([0xfb, 0xef, 0xbe]); // encodes to '++' / '//' in plain base64
        const part: GmailMessagePart = {
            mimeType: 'application/octet-stream',
            body: { data: bytes.toString('base64url') },
        };
        expect(Buffer.from(decodePartBody(part), 'utf8').length).toBeGreaterThan(0);
    });

    it('returns an empty string for a part with no data', () => {
        expect(decodePartBody({ mimeType: 'text/plain' })).toBe('');
    });
});

describe('MIME traversal depth', () => {
    // M1: every walk was unbounded recursion over structure controlled by
    // whoever sent the mail. A few thousand nested multipart levels overflowed
    // the call stack, and for a stdio MCP server that kills the session.
    const HOSTILE_DEPTH = 50_000;

    it('walkParts stops at the depth ceiling instead of overflowing', () => {
        const bomb = nest(HOSTILE_DEPTH, { mimeType: 'text/plain', body: { data: b64url('x') } });
        let visited = 0;
        expect(() => walkParts(bomb, () => { visited += 1; })).not.toThrow();
        expect(visited).toBe(MAX_MIME_DEPTH + 1);
    });

    it('extractEmailContent survives a deeply nested message', () => {
        const bomb = nest(HOSTILE_DEPTH, { mimeType: 'text/plain', body: { data: b64url('deep') } });
        expect(() => extractEmailContent(bomb)).not.toThrow();
    });

    it('extractAttachments survives a deeply nested message', () => {
        const bomb = nest(HOSTILE_DEPTH, {
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            body: { attachmentId: 'att1', size: 10 },
        });
        expect(() => extractAttachments(bomb)).not.toThrow();
    });

    it('findAttachmentFilename survives a deeply nested message', () => {
        const bomb = nest(HOSTILE_DEPTH, {
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            body: { attachmentId: 'att1' },
        });
        expect(() => findAttachmentFilename(bomb, 'att1')).not.toThrow();
    });

    it('collectForwardAttachments survives a deeply nested message', () => {
        const bomb = nest(HOSTILE_DEPTH, {
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            body: { attachmentId: 'att1', size: 10 },
        });
        expect(() => collectForwardAttachments(bomb as any)).not.toThrow();
        expect(MAX_FORWARD_MIME_DEPTH).toBe(MAX_MIME_DEPTH);
    });

    it('still reads content at realistic nesting depths', () => {
        const message = nest(4, { mimeType: 'text/plain', body: { data: b64url('hello') } });
        expect(extractEmailContent(message).text).toBe('hello');
    });
});

describe('extractEmailContent', () => {
    it('concatenates text and html parts', () => {
        const message: GmailMessagePart = {
            mimeType: 'multipart/alternative',
            parts: [
                { mimeType: 'text/plain', body: { data: b64url('plain') } },
                { mimeType: 'text/html', body: { data: b64url('<p>html</p>') } },
            ],
        };
        expect(extractEmailContent(message)).toEqual({ text: 'plain', html: '<p>html</p>' });
    });

    it('decodes each part with its own charset', () => {
        const message: GmailMessagePart = {
            mimeType: 'multipart/alternative',
            parts: [
                {
                    mimeType: 'text/plain',
                    headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }],
                    body: { data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') },
                },
                { mimeType: 'text/html', body: { data: b64url('<p>café</p>') } },
            ],
        };
        expect(extractEmailContent(message)).toEqual({ text: 'café', html: '<p>café</p>' });
    });

    it('returns empty strings for a message with no body parts', () => {
        expect(extractEmailContent({ mimeType: 'multipart/mixed' })).toEqual({ text: '', html: '' });
    });
});

describe('extractAttachments', () => {
    it('reports sanitized filenames', () => {
        const payload: GmailMessagePart = {
            mimeType: 'multipart/mixed',
            parts: [
                {
                    mimeType: 'application/pdf',
                    filename: '../../etc/passwd',
                    body: { attachmentId: 'att1', size: 42 },
                },
                {
                    mimeType: 'image/png',
                    body: { attachmentId: 'x'.repeat(600), size: 7 },
                },
            ],
        };

        const [first, second] = extractAttachments(payload);
        expect(first.filename).toBe('passwd');
        expect(first.size).toBe(42);
        expect(second.filename.startsWith('attachment-')).toBe(true);
        expect(Buffer.byteLength(second.filename)).toBeLessThanOrEqual(200);
    });

    it('returns an empty list when there are no attachments', () => {
        expect(extractAttachments({ mimeType: 'text/plain', body: { data: b64url('x') } })).toEqual([]);
    });
});

describe('findAttachmentFilename', () => {
    it('finds a nested attachment by id', () => {
        const payload: GmailMessagePart = {
            mimeType: 'multipart/mixed',
            parts: [
                { mimeType: 'text/plain', body: { data: b64url('x') } },
                {
                    mimeType: 'multipart/related',
                    parts: [{ mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'att9' } }],
                },
            ],
        };
        expect(findAttachmentFilename(payload, 'att9')).toBe('logo.png');
    });

    it('returns undefined when the id is absent', () => {
        expect(findAttachmentFilename({ mimeType: 'text/plain' }, 'nope')).toBeUndefined();
    });
});
