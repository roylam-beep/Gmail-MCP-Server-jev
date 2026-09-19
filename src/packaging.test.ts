import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO_ROOT, 'dist');

/**
 * `files: ["dist", "README.md"]` ships whatever tsc emitted, so anything that
 * stops excluding the tests silently publishes them.
 *
 * That is not hypothetical: changing the exclude glob to
 * `src/**\/*.test.?(c|m)ts` looked like a tidy-up but TypeScript's globs
 * support only `*`, `?` and `**` — not extglob — so the pattern matched
 * nothing, 20 test files landed in dist/, and the tarball went from 17 files
 * to 37. Nothing in the build, the typecheck or the test run objected.
 */
describe.skipIf(!fs.existsSync(DIST))('published output', () => {
    const emitted = fs.readdirSync(DIST);

    it('contains the entry point', () => {
        expect(emitted).toContain('index.js');
    });

    it('contains no test files', () => {
        expect(emitted.filter(f => /\.test\.[cm]?js$/.test(f))).toEqual([]);
    });

    it('contains no declaration or map files that were never asked for', () => {
        expect(emitted.filter(f => /\.d\.ts$|\.map$/.test(f))).toEqual([]);
    });
});

describe('tsconfig excludes every test file extension', () => {
    it('lists each extension literally rather than relying on extglob', () => {
        // TypeScript does not implement `?(a|b)`; a pattern using it excludes
        // nothing and fails silently.
        const raw = fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8');
        expect(raw).not.toMatch(/\?\([^)]*\)/);
        for (const ext of ['ts', 'mts', 'cts']) {
            expect(raw).toContain(`src/**/*.test.${ext}`);
        }
    });

    // Spawning tsc takes several seconds; the default 5s budget is not enough.
    it('actually keeps test files out of the tsc program', { timeout: 60_000 }, () => {
        const listed = execFileSync(
            'npx',
            ['tsc', '--noEmit', '--listFiles'],
            { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        );
        const tests = listed
            .split('\n')
            .filter(line => line.startsWith(REPO_ROOT) && /\.test\.[cm]?ts$/.test(line));
        expect(tests).toEqual([]);
    });
});
