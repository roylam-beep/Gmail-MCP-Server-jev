import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    SECRET_FILE_MODE,
    SECRET_DIR_MODE,
    ensureSecureDirFor,
    hardenFilePermissions,
    writeSecretFileAtomic,
    writeSecretJsonAtomic,
} from './secure-store.js';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-secure-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

describe('ensureSecureDirFor', () => {
    it('creates a missing parent directory owner-only', () => {
        const target = path.join(tmpDir, 'nested', 'deeper', 'credentials.json');
        ensureSecureDirFor(target);

        const dir = path.dirname(target);
        expect(fs.existsSync(dir)).toBe(true);
        expect(modeOf(dir)).toBe(SECRET_DIR_MODE);
    });

    it('is a no-op when the directory already exists', () => {
        const target = path.join(tmpDir, 'credentials.json');
        expect(() => ensureSecureDirFor(target)).not.toThrow();
        expect(() => ensureSecureDirFor(target)).not.toThrow();
    });
});

describe('hardenFilePermissions', () => {
    it('tightens a world-readable secret', () => {
        const file = path.join(tmpDir, 'credentials.json');
        fs.writeFileSync(file, '{}');
        fs.chmodSync(file, 0o644);

        expect(hardenFilePermissions(file)).toBe(true);
        expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    });

    it('reports no change when already owner-only', () => {
        const file = path.join(tmpDir, 'credentials.json');
        fs.writeFileSync(file, '{}', { mode: SECRET_FILE_MODE });
        fs.chmodSync(file, SECRET_FILE_MODE);

        expect(hardenFilePermissions(file)).toBe(false);
        expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    });

    it('does not throw for a missing file', () => {
        expect(hardenFilePermissions(path.join(tmpDir, 'nope.json'))).toBe(false);
    });
});

describe('writeSecretFileAtomic', () => {
    it('writes the contents with owner-only permissions', () => {
        const file = path.join(tmpDir, 'credentials.json');
        writeSecretFileAtomic(file, 'hello');

        expect(fs.readFileSync(file, 'utf8')).toBe('hello');
        expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    });

    it('tightens permissions on an existing world-readable file', () => {
        // fs.writeFileSync's `mode` option only applies on creation, so the old
        // code left a pre-existing 0644 credentials.json world-readable forever.
        const file = path.join(tmpDir, 'credentials.json');
        fs.writeFileSync(file, 'old', { mode: 0o644 });
        fs.chmodSync(file, 0o644);

        writeSecretFileAtomic(file, 'new');

        expect(fs.readFileSync(file, 'utf8')).toBe('new');
        expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    });

    it('leaves no temp files behind', () => {
        const file = path.join(tmpDir, 'credentials.json');
        writeSecretFileAtomic(file, 'a');
        writeSecretFileAtomic(file, 'b');

        expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    it('creates the parent directory when it is missing', () => {
        const file = path.join(tmpDir, 'fresh', 'credentials.json');
        writeSecretFileAtomic(file, '{}');

        expect(fs.readFileSync(file, 'utf8')).toBe('{}');
        expect(modeOf(path.dirname(file))).toBe(SECRET_DIR_MODE);
    });

    it('never leaves a truncated file when the write fails', () => {
        // The point of the temp-file + rename dance: a failing write must not
        // destroy the credentials already on disk. A plain writeFileSync
        // truncates the target first, so the same failure would wipe the
        // refresh token and force a re-authentication.
        const file = path.join(tmpDir, 'credentials.json');
        const original = '{"tokens":{"refresh_token":"keep-me"}}';
        writeSecretFileAtomic(file, original);

        const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
            throw new Error('ENOSPC: no space left on device');
        });

        try {
            expect(() => writeSecretFileAtomic(file, '{"tokens":{}}')).toThrow(/ENOSPC/);
        } finally {
            fsync.mockRestore();
        }

        expect(fs.readFileSync(file, 'utf8')).toBe(original);
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).tokens.refresh_token).toBe('keep-me');
        // The aborted attempt cleans up after itself.
        expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    it('never leaves a truncated file when the rename fails', () => {
        const file = path.join(tmpDir, 'credentials.json');
        const original = '{"tokens":{"refresh_token":"keep-me"}}';
        writeSecretFileAtomic(file, original);

        const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw new Error('EXDEV: cross-device link not permitted');
        });

        try {
            expect(() => writeSecretFileAtomic(file, '{"tokens":{}}')).toThrow(/EXDEV/);
        } finally {
            rename.mockRestore();
        }

        expect(fs.readFileSync(file, 'utf8')).toBe(original);
        expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });
});

describe('writeSecretJsonAtomic', () => {
    it('round-trips a credentials payload', () => {
        const file = path.join(tmpDir, 'credentials.json');
        const payload = { tokens: { refresh_token: 'r', access_token: 'a' }, scopes: ['gmail.readonly'] };

        writeSecretJsonAtomic(file, payload);

        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(payload);
        expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    });
});
