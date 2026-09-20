#!/usr/bin/env node
/**
 * Interactive first-run setup.
 *
 * Someone has to register an OAuth client with Google once — Gmail scopes are
 * "restricted", so a shared client would need a CASA security assessment and
 * annual recertification, which is why even Google's own Gmail MCP server asks
 * you to bring your own. This cannot be removed; it can be made short.
 *
 * So: find the keys file wherever it landed, check it before the browser
 * opens rather than after, and say exactly what to click when it is missing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const KEYS_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');

const bold = (s: string) => `\u001b[1m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
const green = (s: string) => `\u001b[32m${s}\u001b[0m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[0m`;
const red = (s: string) => `\u001b[31m${s}\u001b[0m`;

/** Places a downloaded client_secret_*.json plausibly ends up. */
export function candidateKeyPaths(home: string, cwd: string): string[] {
    return [
        path.join(cwd, 'gcp-oauth.keys.json'),
        path.join(home, 'Downloads'),
        path.join(home, 'Desktop'),
        cwd,
    ];
}

/**
 * True when the file is a usable OAuth client file. Checking the SHAPE here
 * means a wrong download (an API key, a service account) is caught before the
 * browser opens, not after a confusing failure mid-flow.
 */
export function readOAuthKeys(file: string): { ok: true; type: string } | { ok: false; reason: string } {
    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error: any) {
        return { ok: false, reason: `not valid JSON (${error.message})` };
    }

    const block = parsed.installed || parsed.web;
    if (!block) {
        if (parsed.type === 'service_account') {
            return { ok: false, reason: 'this is a SERVICE ACCOUNT key — Gmail needs an "OAuth client ID" instead' };
        }
        return { ok: false, reason: 'no "installed" or "web" section — this is not an OAuth client file' };
    }
    if (!block.client_id || !block.client_secret) {
        return { ok: false, reason: 'missing client_id or client_secret' };
    }
    return { ok: true, type: parsed.installed ? 'Desktop app' : 'Web application' };
}

/** Find a downloaded OAuth client file that has not been put in place yet. */
export function findDownloadedKeys(searchDirs: string[]): string | undefined {
    for (const entry of searchDirs) {
        try {
            const stat = fs.statSync(entry);
            if (stat.isFile()) {
                if (readOAuthKeys(entry).ok) return entry;
                continue;
            }
            if (!stat.isDirectory()) continue;

            const matches = fs.readdirSync(entry)
                .filter(f => /^client_secret.*\.json$/i.test(f) || f === 'gcp-oauth.keys.json')
                .map(f => path.join(entry, f))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

            for (const match of matches) {
                if (readOAuthKeys(match).ok) return match;
            }
        } catch { /* unreadable path — keep looking */ }
    }
    return undefined;
}

function printConsoleSteps(): void {
    console.log(`
${bold('You need an OAuth client once.')} Gmail scopes are "restricted", so a shared one
would need a CASA security assessment and annual recertification — which is why
even Google's own Gmail MCP server asks you to bring your own.

${dim('If you already use another Google Cloud project (Ads, Sheets, ...), reuse it —')}
${dim('the consent screen is already configured, so only steps 2 and 3 apply.')}

  ${bold('1.')} Create or pick a project
     https://console.cloud.google.com/projectcreate

  ${bold('2.')} Enable the Gmail API for it
     https://console.cloud.google.com/apis/library/gmail.googleapis.com

  ${bold('3.')} Create the credential
     https://console.cloud.google.com/apis/credentials
     → Create Credentials → OAuth client ID → ${bold('Desktop app')} → Create → Download JSON

     ${dim('Desktop app needs no redirect URI. If you pick "Web application" instead,')}
     ${dim('add http://localhost:3000/oauth2callback to its authorized redirect URIs.')}

  ${bold('4.')} Add yourself as a test user (skip if the project is already published)
     https://console.cloud.google.com/apis/credentials/consent
     → Audience → Test users → Add users → your Gmail address

Then run this again — it picks the download up from your Downloads folder
automatically, so there is nothing to rename or move.
`);
}

export function main(argv: string[] = process.argv.slice(2)): number {
    console.log(bold('\nGmail MCP — setup\n'));

    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) {
        console.log(red(`✗ Node ${process.versions.node} — this server needs Node 22 or newer.`));
        return 1;
    }
    console.log(green(`✓ Node ${process.versions.node}`));

    if (!fs.existsSync(ENTRY)) {
        console.log(red(`✗ ${ENTRY} is missing — run \`npm run build\` first.`));
        return 1;
    }
    console.log(green('✓ Built'));

    // 1. Keys in place?
    let keysReady = fs.existsSync(KEYS_PATH) && readOAuthKeys(KEYS_PATH).ok;

    // 2. Otherwise, pick up a download without making the user move it.
    if (!keysReady) {
        const found = findDownloadedKeys(candidateKeyPaths(os.homedir(), process.cwd()));
        if (found) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
            fs.copyFileSync(found, KEYS_PATH);
            fs.chmodSync(KEYS_PATH, 0o600);
            const kind = readOAuthKeys(KEYS_PATH) as { ok: true; type: string };
            console.log(green(`✓ Found your OAuth client (${kind.type}) at ${found}`));
            console.log(dim(`  copied to ${KEYS_PATH}`));
            keysReady = true;
        }
    } else {
        const kind = readOAuthKeys(KEYS_PATH) as { ok: true; type: string };
        console.log(green(`✓ OAuth client in place (${kind.type})`));
    }

    if (!keysReady) {
        // Say WHY the file that is there is unusable, rather than just "missing".
        if (fs.existsSync(KEYS_PATH)) {
            const why = readOAuthKeys(KEYS_PATH) as { ok: false; reason: string };
            console.log(red(`✗ ${KEYS_PATH} is unusable: ${why.reason}`));
        } else {
            console.log(yellow('✗ No OAuth client found.'));
        }
        printConsoleSteps();
        return 1;
    }

    // 3. Already authenticated?
    if (fs.existsSync(CREDENTIALS_PATH) && !argv.includes('--reauth')) {
        console.log(green('✓ Already authenticated'));
        console.log(`\n${dim('Re-authenticate with:')} npm run setup -- --reauth\n`);
        printClientConfig();
        return 0;
    }

    // --check answers "is my setup right?" without launching a browser, which
    // is also the only way to verify this end to end in a test.
    if (argv.includes('--check')) {
        console.log(yellow('\n! Not authenticated yet.'));
        console.log(`${dim('Run:')} npm run setup\n`);
        return 2;
    }

    // 4. Hand over to the real auth flow — it prints the URL and opens a browser.
    console.log(`\n${bold('Opening Google sign-in...')}`);
    console.log(dim('The consent screen will warn about an unverified app: that is your own'));
    console.log(dim('project, so choose Advanced → Go to (unsafe).\n'));

    const scopesArg = argv.find(a => a.startsWith('--scopes='));
    const result = spawnSync('node', [ENTRY, 'auth', ...(scopesArg ? [scopesArg] : [])], { stdio: 'inherit' });
    if (result.status !== 0) return result.status ?? 1;

    console.log(green('\n✓ Authenticated'));
    printClientConfig();
    return 0;
}

function printClientConfig(): void {
    console.log(`
${bold('Connect it to Claude')}

  Claude Code:
    claude mcp add gmail -- node ${ENTRY}

  Claude Desktop — add to claude_desktop_config.json, then fully quit and reopen:
${dim(JSON.stringify({ mcpServers: { gmail: { command: 'node', args: [ENTRY] } } }, null, 2)
        .split('\n').map(l => '    ' + l).join('\n'))}

  Then ask Claude: "list my Gmail labels"
`);
}

// Only run when invoked directly, so the helpers stay unit-testable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main());
}
