import { describe, it, expect } from 'vitest';
import path from 'path';
import {
    sanitizeFilename,
    fallbackAttachmentName,
    resolveWithinDirectory,
    MAX_FILENAME_BYTES,
} from './filename-utils.js';

describe('sanitizeFilename', () => {
    it('keeps an ordinary name unchanged', () => {
        expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    });

    it('strips POSIX directory components', () => {
        expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
        expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    });

    it('strips Windows directory components', () => {
        // path.basename() on POSIX treats this as ONE component and returns it
        // verbatim, which is the bug this replaces.
        expect(sanitizeFilename('..\\..\\Windows\\system32\\evil.exe')).toBe('evil.exe');
        expect(sanitizeFilename('C:\\secrets\\key.pem')).toBe('key.pem');
    });

    it('never returns a traversal name', () => {
        for (const input of ['..', '.', '...', './', '../']) {
            const result = sanitizeFilename(input);
            expect(result).not.toBe('..');
            expect(result).not.toBe('.');
            expect(result.includes(path.sep)).toBe(false);
        }
    });

    it('never returns an empty name', () => {
        expect(sanitizeFilename('')).toBe('unnamed');
        expect(sanitizeFilename('   ')).toBe('unnamed');
        expect(sanitizeFilename('....')).toBe('unnamed');
    });

    it('replaces control characters and Windows-illegal characters', () => {
        expect(sanitizeFilename('a\u0000b.txt')).toBe('a_b.txt');
        expect(sanitizeFilename('in<val>id:name?.txt')).toBe('in_val_id_name_.txt');
        expect(sanitizeFilename('line\nbreak.txt')).toBe('line_break.txt');
    });

    it('truncates a reserved device name with an over-long extension', () => {
        // The reserved-name pattern accepts an extension of any length, so the
        // escape must not short-circuit the byte cap.
        const result = sanitizeFilename('CON.' + 'y'.repeat(500));
        expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
        expect(result.startsWith('_CON')).toBe(true);
    });

    it('keeps a reserved name at the byte cap within budget once prefixed', () => {
        // The '_' prefix costs a byte, so a name sitting exactly on the cap
        // must still come back within it.
        const result = sanitizeFilename('nul.' + 'y'.repeat(MAX_FILENAME_BYTES - 4));
        expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
        expect(result.startsWith('_nul')).toBe(true);
    });

    it('escapes Windows reserved device names', () => {
        expect(sanitizeFilename('CON')).toBe('_CON');
        expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
        expect(sanitizeFilename('COM1.log')).toBe('_COM1.log');
        expect(sanitizeFilename('console.txt')).toBe('console.txt');
    });

    it('drops trailing dots and spaces that Windows silently strips', () => {
        expect(sanitizeFilename('evil.txt. ')).toBe('evil.txt');
        expect(sanitizeFilename('name   ')).toBe('name');
    });

    it('does not produce a hidden dotfile', () => {
        expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    });

    it('is not fooled by Unicode whitespace around the dots', () => {
        // The edge strips used to run before trim(), and trim() removes the
        // whole Unicode whitespace set while the strips only covered ASCII
        // space — so one NBSP put the leading dot back. An attachment named
        // " .bashrc" by the SENDER then wrote a dotfile into savePath.
        expect(sanitizeFilename(' .bashrc')).toBe('bashrc');
        expect(sanitizeFilename('\u00A0.bashrc')).toBe('bashrc');
        expect(sanitizeFilename('\uFEFF.profile\uFEFF')).toBe('profile');
        expect(sanitizeFilename('evil.txt.\u00A0')).toBe('evil.txt');
        for (const input of ['\u00A0..\u00A0', '\uFEFF..\uFEFF', '\u00A0.\u00A0', '\u2028.\u2029']) {
            const result = sanitizeFilename(input);
            expect(result).not.toBe('..');
            expect(result).not.toBe('.');
            expect(result).toBe('unnamed');
        }
    });

    it('does not re-introduce a trailing dot or space when truncating', () => {
        // The byte-cap fallthrough runs long after the edge strip, so whatever
        // byte 200 lands on used to survive. Windows treats "x." and "x" as the
        // same file, so a trailing dot silently changes the name.
        const dotAtBoundary = sanitizeFilename('a'.repeat(199) + '.' + 'b'.repeat(200));
        expect(dotAtBoundary.endsWith('.')).toBe(false);

        const spaceAtBoundary = sanitizeFilename('a'.repeat(198) + '. ' + 'b'.repeat(300));
        expect(/[\s.]$/.test(spaceAtBoundary)).toBe(false);

        for (const name of [dotAtBoundary, spaceAtBoundary]) {
            expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
            expect(name.length).toBeGreaterThan(0);
        }
    });

    it('truncates to the byte budget and keeps the extension', () => {
        const long = 'a'.repeat(500) + '.pdf';
        const result = sanitizeFilename(long);
        expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
        expect(result.endsWith('.pdf')).toBe(true);
    });

    it('counts bytes, not characters, for multi-byte names', () => {
        // 200 CJK characters is 600 UTF-8 bytes — under a character-based cap
        // but well over the filesystem's byte limit.
        const long = '附件'.repeat(200) + '.pdf';
        const result = sanitizeFilename(long);
        expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
        expect(result.endsWith('.pdf')).toBe(true);
    });

    it('never splits a multi-byte character when truncating', () => {
        const result = sanitizeFilename('文'.repeat(300) + '.txt');
        // A split UTF-8 sequence would round-trip as U+FFFD.
        expect(result).not.toContain('\uFFFD');
        expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
    });

    it('truncates when the "extension" is itself absurdly long', () => {
        const result = sanitizeFilename('x.' + 'y'.repeat(600));
        expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
        expect(result.length).toBeGreaterThan(0);
    });
});

describe('fallbackAttachmentName', () => {
    it('stays well within the filesystem limit for a very long attachment id', () => {
        const id = 'ANGjdJ_' + 'x'.repeat(600);
        const name = fallbackAttachmentName(id);
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
        expect(name.startsWith('attachment-')).toBe(true);
    });

    it('produces a single safe component even for a hostile id', () => {
        const name = fallbackAttachmentName('../../etc/pa');
        expect(name.includes('/')).toBe(false);
        expect(name.includes('\\')).toBe(false);
    });
});

describe('resolveWithinDirectory', () => {
    it('resolves a plain filename inside the directory', () => {
        expect(resolveWithinDirectory('/tmp/out', 'a.pdf')).toBe(path.resolve('/tmp/out/a.pdf'));
    });

    it('works when the directory is a filesystem root', () => {
        // A `startsWith(dir + sep)` check made the prefix '//' for '/', so every
        // filename was rejected with a misleading traversal error.
        expect(resolveWithinDirectory('/', 'a.txt')).toBe(path.resolve('/a.txt'));
    });

    it('rejects a filename that resolves to the directory itself', () => {
        // Writing there hits EISDIR; there is no valid case for it.
        expect(() => resolveWithinDirectory('/tmp/out', '.')).toThrow(/path traversal/);
        expect(() => resolveWithinDirectory('/tmp/out', '')).toThrow(/path traversal/);
    });

    it('tolerates a trailing separator on the directory', () => {
        expect(resolveWithinDirectory('/tmp/out/', 'a.pdf')).toBe(path.resolve('/tmp/out/a.pdf'));
    });

    it('rejects an escape attempt', () => {
        expect(() => resolveWithinDirectory('/tmp/out', '../evil')).toThrow(/path traversal/);
        expect(() => resolveWithinDirectory('/tmp/out', '/etc/passwd')).toThrow(/path traversal/);
    });

    it('rejects a sibling directory that merely shares a prefix', () => {
        expect(() => resolveWithinDirectory('/tmp/out', '../outsider/x')).toThrow(/path traversal/);
    });

    it('accepts the sanitized form of a traversal filename', () => {
        const safe = sanitizeFilename('../../etc/passwd');
        expect(resolveWithinDirectory('/tmp/out', safe)).toBe(path.resolve('/tmp/out/passwd'));
    });

    it('accepts a sanitized message-id-derived filename', () => {
        // download_email builds `${messageId}.${format}` from caller input.
        const safe = sanitizeFilename('../../../root/.ssh/authorized_keys.json');
        expect(resolveWithinDirectory('/tmp/out', safe)).toBe(
            path.resolve('/tmp/out/authorized_keys.json'),
        );
    });
});
