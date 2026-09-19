import { describe, it, expect } from 'vitest';
import { createEmailMessage, encodeBodyPart } from './utl.js';

/**
 * H9: the builder labelled every part `charset=UTF-8` with
 * `Content-Transfer-Encoding: 7bit`. A non-ASCII body is 8-bit octets, so the
 * declaration was false for every CJK / accented / emoji message.
 */
describe('encodeBodyPart', () => {
    it('leaves a plain ASCII body as 7bit', () => {
        const { encoding, body } = encodeBodyPart('hello world');
        expect(encoding).toBe('7bit');
        expect(body).toBe('hello world');
    });

    it('base64-encodes a non-ASCII body', () => {
        const { encoding, body } = encodeBodyPart('中文內容');
        expect(encoding).toBe('base64');
        expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('中文內容');
    });

    it('base64-encodes emoji', () => {
        const { encoding, body } = encodeBodyPart('ship it 🚀');
        expect(encoding).toBe('base64');
        expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('ship it 🚀');
    });

    it('wraps base64 output at 76 characters per RFC 2045', () => {
        const { body } = encodeBodyPart('中'.repeat(500));
        for (const line of body.split('\r\n')) {
            expect(line.length).toBeLessThanOrEqual(76);
        }
    });

    it('base64-encodes an ASCII body whose lines exceed the RFC 5322 limit', () => {
        // A 2000-character single line would be folded or truncated in transit.
        const { encoding, body } = encodeBodyPart('x'.repeat(2000));
        expect(encoding).toBe('base64');
        expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
            'x'.repeat(2000),
        );
    });

    it('handles an empty body', () => {
        expect(encodeBodyPart('')).toEqual({ encoding: '7bit', body: '' });
    });
});

describe('createEmailMessage transfer encoding', () => {
    const base = { to: ['a@example.com'], subject: 'hi' };

    it('declares base64 for a non-ASCII plain text body', () => {
        const message = createEmailMessage({ ...base, body: '您好，這是測試郵件。' });

        expect(message).toContain('Content-Type: text/plain; charset=UTF-8');
        expect(message).toContain('Content-Transfer-Encoding: base64');
        expect(message).not.toContain('Content-Transfer-Encoding: 7bit');

        const payload = message.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        expect(Buffer.from(payload.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
            '您好，這是測試郵件。',
        );
    });

    it('keeps 7bit for an ASCII plain text body', () => {
        const message = createEmailMessage({ ...base, body: 'plain ascii' });
        expect(message).toContain('Content-Transfer-Encoding: 7bit');
        expect(message).toContain('plain ascii');
    });

    it('encodes each part of a multipart/alternative message independently', () => {
        const message = createEmailMessage({
            ...base,
            body: 'ascii only',
            htmlBody: '<p>中文</p>',
            mimeType: 'multipart/alternative',
        });

        expect(message).toContain('Content-Transfer-Encoding: 7bit');
        expect(message).toContain('Content-Transfer-Encoding: base64');
        expect(message).toContain('ascii only');
        expect(message).not.toContain('<p>中文</p>');
    });

    it('declares base64 for a non-ASCII HTML-only body', () => {
        const message = createEmailMessage({
            ...base,
            body: '',
            htmlBody: '<p>測試</p>',
            mimeType: 'text/html',
        });
        expect(message).toContain('Content-Type: text/html; charset=UTF-8');
        expect(message).toContain('Content-Transfer-Encoding: base64');
    });
});

describe('RFC 2047 subject encoding', () => {
    const base = { to: ['a@example.com'], body: 'x' };

    it('leaves an ASCII subject unencoded', () => {
        const message = createEmailMessage({ ...base, subject: 'Quarterly report' });
        expect(message).toContain('Subject: Quarterly report');
    });

    it('encodes a non-ASCII subject', () => {
        const message = createEmailMessage({ ...base, subject: '季度報告' });
        const line = message.split('\r\n').find(l => l.startsWith('Subject:'))!;
        expect(line).toMatch(/^Subject: =\?UTF-8\?B\?/);
        const payload = /=\?UTF-8\?B\?([^?]+)\?=/.exec(line)![1];
        expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('季度報告');
    });

    it('keeps every encoded-word within the RFC 2047 75-character limit', () => {
        // A long CJK subject used to become one oversized encoded-word, which
        // strict clients render as literal =?UTF-8?B?... text.
        const subject = '這是一封主旨非常長的中文郵件用來測試編碼字的折行行為'.repeat(4);
        const message = createEmailMessage({ ...base, subject });

        const words = message.match(/=\?UTF-8\?B\?[^?]+\?=/g)!;
        expect(words.length).toBeGreaterThan(1);
        for (const word of words) {
            expect(word.length).toBeLessThanOrEqual(75);
        }

        const decoded = words
            .map(w => Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(w)![1], 'base64').toString('utf8'))
            .join('');
        expect(decoded).toBe(subject);
    });

    it('folds continuation encoded-words onto their own lines', () => {
        const subject = '主旨'.repeat(60);
        const message = createEmailMessage({ ...base, subject });
        const lines = message.split('\r\n');
        const subjectIndex = lines.findIndex(l => l.startsWith('Subject:'));

        // Continuation lines of a folded header start with whitespace.
        expect(lines[subjectIndex + 1].startsWith(' ')).toBe(true);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(998);
        }
    });

    it('never splits a multi-byte character across encoded-words', () => {
        const subject = '測試'.repeat(50);
        const message = createEmailMessage({ ...base, subject });
        const words = message.match(/=\?UTF-8\?B\?[^?]+\?=/g)!;
        for (const word of words) {
            const decoded = Buffer.from(
                /=\?UTF-8\?B\?([^?]+)\?=/.exec(word)![1],
                'base64',
            ).toString('utf8');
            expect(decoded).not.toContain('�');
        }
    });
});
