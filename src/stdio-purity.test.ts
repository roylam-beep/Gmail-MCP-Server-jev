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
describe('stdout purity', () => {
    const sources = fs
        .readdirSync(SRC_DIR)
        .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    it('covers every source file', () => {
        expect(sources.length).toBeGreaterThan(0);
        expect(sources).toContain('index.ts');
    });

    for (const file of sources) {
        it(`${file} writes no diagnostics to stdout`, () => {
            const contents = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
            expect(contents).not.toMatch(/\bconsole\.log\s*\(/);
            expect(contents).not.toMatch(/\bconsole\.info\s*\(/);
            expect(contents).not.toMatch(/\bprocess\.stdout\.write\s*\(/);
        });
    }
});
