import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readOAuthKeys, findDownloadedKeys, candidateKeyPaths } from './setup-wizard.js';

let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-wizard-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (name: string, value: unknown) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
};

const desktopClient = {
    installed: { client_id: 'x.apps.googleusercontent.com', client_secret: 's', redirect_uris: ['http://localhost'] },
};

describe('readOAuthKeys', () => {
    it('accepts a Desktop app client', () => {
        expect(readOAuthKeys(write('a.json', desktopClient))).toEqual({ ok: true, type: 'Desktop app' });
    });

    it('accepts a Web application client', () => {
        const web = { web: { client_id: 'x', client_secret: 's' } };
        expect(readOAuthKeys(write('b.json', web))).toEqual({ ok: true, type: 'Web application' });
    });

    it('names the specific wrong file rather than saying "invalid"', () => {
        // Downloading the wrong thing from the Cloud console is the common
        // mistake; catching it here means it surfaces before a browser opens.
        const service = readOAuthKeys(write('c.json', { type: 'service_account', private_key: 'k' }));
        expect(service).toMatchObject({ ok: false });
        expect((service as any).reason).toMatch(/SERVICE ACCOUNT/);

        const apiKey = readOAuthKeys(write('d.json', { apiKey: 'AIza...' }));
        expect((apiKey as any).reason).toMatch(/not an OAuth client file/);

        const truncated = readOAuthKeys(write('e.json', '{"installed":'));
        expect((truncated as any).reason).toMatch(/not valid JSON/);

        const incomplete = readOAuthKeys(write('f.json', { installed: { client_id: 'x' } }));
        expect((incomplete as any).reason).toMatch(/client_secret/);
    });

    it('does not throw on a missing file', () => {
        expect(readOAuthKeys(path.join(tmp, 'nope.json'))).toMatchObject({ ok: false });
    });
});

describe('findDownloadedKeys', () => {
    it('picks up the file Google actually hands you, unrenamed', () => {
        // The console downloads `client_secret_<id>.apps.googleusercontent.com.json`.
        // Requiring a rename is pure friction.
        const downloads = path.join(tmp, 'Downloads');
        fs.mkdirSync(downloads);
        fs.writeFileSync(
            path.join(downloads, 'client_secret_123.apps.googleusercontent.com.json'),
            JSON.stringify(desktopClient),
        );

        expect(findDownloadedKeys([downloads])).toContain('client_secret_123');
    });

    it('prefers the most recent download when there are several', async () => {
        const downloads = path.join(tmp, 'Downloads');
        fs.mkdirSync(downloads);
        const older = path.join(downloads, 'client_secret_old.json');
        const newer = path.join(downloads, 'client_secret_new.json');
        fs.writeFileSync(older, JSON.stringify(desktopClient));
        await new Promise(r => setTimeout(r, 10));
        fs.writeFileSync(newer, JSON.stringify(desktopClient));

        expect(findDownloadedKeys([downloads])).toBe(newer);
    });

    it('skips a file that looks right but is not an OAuth client', () => {
        const downloads = path.join(tmp, 'Downloads');
        fs.mkdirSync(downloads);
        fs.writeFileSync(path.join(downloads, 'client_secret_bad.json'), JSON.stringify({ type: 'service_account' }));

        expect(findDownloadedKeys([downloads])).toBeUndefined();
    });

    it('returns undefined rather than throwing on unreadable paths', () => {
        expect(findDownloadedKeys([path.join(tmp, 'does-not-exist')])).toBeUndefined();
    });

    it('looks where a download actually lands', () => {
        const where = candidateKeyPaths('/home/u', '/work');
        expect(where).toContain(path.join('/home/u', 'Downloads'));
        expect(where).toContain(path.join('/work', 'gcp-oauth.keys.json'));
    });
});
