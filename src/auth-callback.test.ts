import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

/**
 * End-to-end over the real `auth` listener. A codeless hit on the callback
 * path used to end the whole run with "No code provided", so a browser reload,
 * a prefetch, or opening the URL by hand aborted authentication and the user
 * had to start over.
 *
 * Skipped when dist/ is absent — `npm test` runs after `npm run build` in CI,
 * and a stale build would test the wrong thing.
 */
const built = fs.existsSync(ENTRY);

// Skipping the whole end-to-end suite because dist/ happens to be missing is
// how a real regression slips through unnoticed — `npm run prebuild` wipes
// dist/, so a bare `npm test` at the wrong moment silently proves nothing. CI
// always builds first, so there it is an error, not a skip.
if (!built && process.env.CI) {
    throw new Error(
        `${ENTRY} is missing — run \`npm run build\` before \`npm test\`. ` +
        'This suite drives the real server and cannot be skipped in CI.',
    );
}
if (!built) {
    console.warn('[auth-callback] dist/ not built — skipping the end-to-end auth suite.');
}

let home: string;
let proc: ChildProcess | undefined;
let port = 0;
let stderr = '';
let stdout = '';

/**
 * Every test gets its own port. Reusing one across tests failed
 * intermittently: afterEach's SIGKILL returns before the kernel has released
 * the socket, so the next spawn hit EADDRINUSE, exited, and the fetch that
 * followed got ECONNREFUSED. Reproduced roughly 1 run in 5 before this.
 */
function nextPort(): number {
    // Spread by pid so parallel vitest workers and concurrent CI runs on the
    // same machine do not collide.
    return 38000 + ((process.pid * 97) % 20000) + portOffset++;
}
let portOffset = 0;

async function get(pathname: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
    return { status: res.status, body: await res.text() };
}

const waitFor = (predicate: () => boolean | Promise<boolean>, ms = 10000) =>
    new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const tick = async () => {
            try {
                if (await predicate()) return resolve();
            } catch { /* keep polling */ }
            if (Date.now() - started > ms) return reject(new Error('timed out waiting for the listener'));
            setTimeout(tick, 50);
        };
        void tick();
    });

/**
 * Readiness is the port actually accepting a connection, not a line on stderr.
 * The URL is printed before `server.listen` can report EADDRINUSE, so a
 * stderr match would pass for a process that is already on its way out.
 */
async function listening(): Promise<boolean> {
    if (proc?.exitCode !== null && proc?.exitCode !== undefined) {
        throw new Error(`auth exited early (code ${proc.exitCode}):\n${stderr}`);
    }
    const res = await fetch(`http://127.0.0.1:${port}/__ping`).catch(() => undefined);
    return res !== undefined;
}

beforeEach(async () => {
    if (!built) return;
    port = nextPort();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-auth-'));
    fs.mkdirSync(path.join(home, '.gmail-mcp'), { recursive: true });
    fs.writeFileSync(
        path.join(home, '.gmail-mcp', 'gcp-oauth.keys.json'),
        JSON.stringify({
            installed: {
                client_id: 'test.apps.googleusercontent.com',
                client_secret: 'test-secret',
                redirect_uris: [`http://localhost:${port}/oauth2callback`],
            },
        }),
    );

    stderr = '';
    stdout = '';
    proc = spawn('node', [ENTRY, 'auth', `http://localhost:${port}/oauth2callback`], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout!.on('data', d => { stdout += d; });
    proc.stderr!.on('data', d => { stderr += d; });

    await waitFor(listening);
    // The ping above is itself a non-callback request, so drop what it logged.
    stdout = '';
});

afterEach(() => {
    proc?.kill('SIGKILL');
    if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!built)('auth callback listener', () => {
    it('answers a codeless callback hit and keeps listening', async () => {
        const first = await get('/oauth2callback');
        expect(first.status).toBe(400);
        expect(first.body).toMatch(/consent redirect/i);

        // The listener must still be there — this is the whole point.
        const second = await get('/oauth2callback?state=xyz');
        expect(second.status).toBe(400);

        expect(proc!.exitCode).toBeNull();
    });

    it('answers a non-callback path with 404 rather than dropping it', async () => {
        const res = await get('/favicon.ico');
        expect(res.status).toBe(404);
        expect(proc!.exitCode).toBeNull();
    });

    it('ends the run when Google reports a declined consent', async () => {
        const res = await get('/oauth2callback?error=access_denied');
        expect(res.status).toBe(400);
        expect(res.body).toMatch(/access_denied/);

        await waitFor(() => proc!.exitCode !== null);
        expect(proc!.exitCode).toBe(1);
        expect(stderr).toContain('Authentication failed:');
        expect(stderr).toMatch(/declined on the Google consent screen/);
        // An expected, actionable failure should not arrive as a stack trace.
        expect(stderr).not.toContain('Server error:');
        expect(stderr).not.toMatch(/^\s+at /m);
    });

    it('keeps stdout free of anything but the MCP protocol', async () => {
        await get('/oauth2callback');
        await get('/favicon.ico');
        expect(stdout).toBe('');
    });
});
