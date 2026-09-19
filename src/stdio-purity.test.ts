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
    const sources = collectSources(SRC_DIR);

    it('covers every source file', () => {
        expect(sources.length).toBeGreaterThan(0);
        expect(sources.map(f => path.basename(f))).toContain('index.ts');
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
