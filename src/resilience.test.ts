import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasScope } from './scopes.js';
import { toolDefinitions } from './tools.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

if (!fs.existsSync(ENTRY) && process.env.CI) {
    throw new Error(`${ENTRY} is missing — run \`npm run build\` before \`npm test\`.`);
}
const built = fs.existsSync(ENTRY);

const KEYS = JSON.stringify({
    installed: {
        client_id: 'test.apps.googleusercontent.com',
        client_secret: 'test-secret',
        redirect_uris: ['http://localhost:3000/oauth2callback'],
    },
});

let home: string;

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-resilience-'));
    fs.mkdirSync(path.join(home, '.gmail-mcp'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gmail-mcp', 'gcp-oauth.keys.json'), KEYS);
});

afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
});

/** Run the CLI to completion and capture both streams. */
function run(args: string[], ms = 6000): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const proc = spawn('node', [ENTRY, ...args], {
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        const timer = setTimeout(() => proc.kill('SIGKILL'), ms);
        proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
}

/**
 * `auth` waits for a browser callback, so it never exits on its own. Resolve
 * as soon as stderr says what we need rather than waiting for a close that
 * only SIGKILL would produce.
 */
function runUntil(args: string[], predicate: (stderr: string) => boolean, ms = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', [ENTRY, ...args], {
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        const finish = (fn: () => void) => { clearTimeout(timer); proc.kill('SIGKILL'); fn(); };
        const timer = setTimeout(
            () => finish(() => reject(new Error(`timed out; stderr was:\n${stderr}`))),
            ms,
        );
        proc.stderr.on('data', (d) => {
            stderr += d;
            if (predicate(stderr)) finish(() => resolve(stderr));
        });
        proc.on('close', () => finish(() => resolve(stderr)));
    });
}

describe.skipIf(!built)('unreadable credentials are recoverable', () => {
    it('does not block the auth command that repairs them', async () => {
        // credentials.json is a token cache, not configuration. Exiting on an
        // unreadable one was worse than it not existing — and because
        // loadCredentials() runs before the `auth` subcommand is dispatched, it
        // blocked the very command that fixes it.
        fs.writeFileSync(path.join(home, '.gmail-mcp', 'credentials.json'), '{"tokens":{"access_token":"a');

        const stderr = await runUntil(
            ['auth', 'http://localhost:39999/oauth2callback'],
            (s) => s.includes('Please visit this URL'),
        );

        expect(stderr).toMatch(/could not be read/);
        expect(stderr).toMatch(/Run `auth` to sign in again/);
        // It got past loading and into the auth flow itself.
        expect(stderr).toMatch(/Please visit this URL/);
    });

    it('names the OAuth keys file when that is what is malformed', async () => {
        fs.writeFileSync(path.join(home, '.gmail-mcp', 'gcp-oauth.keys.json'), '{not json');

        const { stderr, code } = await run([]);

        expect(stderr).toMatch(/OAuth keys/);
        expect(stderr).toMatch(/gcp-oauth\.keys\.json/);
        // Not the wrong subsystem.
        expect(stderr).not.toMatch(/Error loading credentials/);
        expect(code).toBe(1);
    });

    it('rejects a malformed callback URL with the argument in the message', async () => {
        const { stderr, code } = await run(['auth', 'http://[not a url']);
        expect(stderr).toMatch(/not a valid callback URL/);
        expect(code).toBe(1);
    });
});

describe.skipIf(!built)('unauthenticated server', () => {
    it('says what to run instead of surfacing a library internal', async () => {
        // Previously every call returned google-auth-library's "No access,
        // refresh token, API key or refresh handler callback is set." — which
        // never mentions Gmail, credentials, or auth.
        const proc = spawn('node', [ENTRY], {
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        proc.stdout.on('data', d => { out += d; });
        const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + '\n');

        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
        await new Promise(r => setTimeout(r, 300));
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await new Promise(r => setTimeout(r, 200));
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_emails', arguments: { query: 'x' } } });
        await new Promise(r => setTimeout(r, 900));
        proc.kill('SIGKILL');

        const reply = out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === 2);
        const text = reply.result.content[0].text;

        expect(text).toMatch(/Not authenticated/);
        expect(text).toMatch(/auth/);
        expect(text).not.toMatch(/refresh handler callback/);
    });
});

describe('tools that read before they write require a scope that grants both', () => {
    // reply_all and forward_email fetch the original message (and reply_all the
    // user profile) before sending. Listing gmail.send/gmail.compose made them
    // visible on a send-only grant, then fail with Google's "insufficient
    // authentication scopes" — a 403 contradicting the guard just applied.
    for (const name of ['reply_all', 'forward_email']) {
        it(`${name} is hidden on a send-only or compose-only grant`, () => {
            const tool = toolDefinitions.find(t => t.name === name)!;
            expect(hasScope(['gmail.send'], tool.scopes)).toBe(false);
            expect(hasScope(['gmail.compose'], tool.scopes)).toBe(false);
            expect(hasScope(['gmail.readonly'], tool.scopes)).toBe(false);
        });

        it(`${name} is available on gmail.modify and gmail.full`, () => {
            const tool = toolDefinitions.find(t => t.name === name)!;
            expect(hasScope(['gmail.modify'], tool.scopes)).toBe(true);
            expect(hasScope(['gmail.full'], tool.scopes)).toBe(true);
        });
    }
});
