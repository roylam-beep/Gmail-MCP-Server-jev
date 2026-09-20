import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * H1: stdout carries the MCP JSON-RPC stream (StdioServerTransport). A stray
 * console.log injects a non-protocol line into that stream and the client's
 * parser rejects the session. Diagnostics must go to stderr.
 */
/**
 * Every console method that writes to stdout on Node. `warn`, `error`,
 * `trace` and `assert` go to stderr and are fine; `debug` — the one a
 * developer is most likely to reach for — does not, and the original check
 * missed it along with `dir`, `table`, `group`, `count` and `timeEnd`.
 */
const STDOUT_CONSOLE_METHODS = [
    'log', 'info', 'debug', 'dir', 'table',
    'group', 'groupCollapsed', 'count', 'countReset', 'timeEnd', 'timeLog',
];

/** Recursive, so a future src/handlers/foo.ts is not silently skipped. */
function collectSources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...collectSources(full));
        } else if (/\.[cm]?ts$/.test(entry.name) && !/\.test\.[cm]?ts$/.test(entry.name)) {
            found.push(full);
        }
    }
    return found;
}

describe('stdout purity', () => {
    /**
     * setup-wizard.ts is a CLI the user runs by hand; stdout is its output, not
     * a protocol stream. The exemption is narrow on purpose and the test below
     * enforces that it stays narrow: if the server ever imported it, its
     * console.log would land in the JSON-RPC stream and this rule would have
     * been quietly voided.
     */
    const CLI_ONLY = new Set(['setup-wizard.ts']);

    const sources = collectSources(SRC_DIR).filter(f => !CLI_ONLY.has(path.basename(f)));

    it('covers every source file', () => {
        expect(sources.length).toBeGreaterThan(0);
        expect(sources.map(f => path.basename(f))).toContain('index.ts');
    });

    it('the stdout-writing CLI is never pulled into the server', () => {
        const server = fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf8');
        for (const cli of CLI_ONLY) {
            const moduleName = cli.replace(/\.ts$/, '');
            expect(server).not.toMatch(new RegExp(`from ['"]\\./${moduleName}\\.js['"]`));
        }
    });

    for (const file of sources) {
        it(`${path.relative(SRC_DIR, file)} writes no diagnostics to stdout`, () => {
            const contents = fs.readFileSync(file, 'utf8');
            for (const method of STDOUT_CONSOLE_METHODS) {
                expect(contents, `console.${method} writes to stdout`)
                    .not.toMatch(new RegExp(`\\bconsole\\.${method}\\s*\\(`));
            }
            // Bracket access defeats the property check above.
            expect(contents).not.toMatch(/\bconsole\s*\[/);
            expect(contents).not.toMatch(/\bprocess\.stdout\b/);
        });
    }
});
