import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * H5: the supported Node version is declared in five places. When they drift,
 * CI validates the build on a runtime the package does not claim to support
 * (or refuses to install at all). All five must name the same major.
 */
const EXPECTED_MAJOR = 22;

describe('Node version alignment', () => {
    it('package.json engines pins the expected major', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.engines.node).toBe(`>=${EXPECTED_MAJOR}.0.0`);
    });

    it('mcpb-manifest.json declares the same runtime floor', () => {
        const manifest = JSON.parse(read('mcpb-manifest.json'));
        expect(manifest.compatibility.runtimes.node).toBe(`>=${EXPECTED_MAJOR}.0.0`);
    });

    it('every Dockerfile stage builds on the same major', () => {
        // Without /g only the first FROM was checked, so a second build stage
        // on a different major would slip through.
        const stages = [...read('Dockerfile').matchAll(/^FROM node:(\d+)/gm)];
        expect(stages.length).toBeGreaterThan(0);
        for (const stage of stages) {
            expect(Number(stage[1])).toBe(EXPECTED_MAJOR);
        }
    });

    it('every workflow sets up the same major', () => {
        // A literal-only regex silently ignores `node-version: ${{ matrix.x }}`,
        // a `[18, 20]` list and `node-version-file:` — so migrating a workflow
        // to a matrix escaped the check entirely while the assertion still
        // passed on some other file's surviving literal. Every declaration is
        // collected, and a non-literal one fails rather than being skipped.
        const workflowDir = path.join(REPO_ROOT, '.github', 'workflows');
        const workflows = fs.readdirSync(workflowDir).filter(f => /\.ya?ml$/.test(f));
        const declarations: Array<{ file: string; raw: string }> = [];

        for (const file of workflows) {
            const contents = fs.readFileSync(path.join(workflowDir, file), 'utf8');
            for (const match of contents.matchAll(/node-version(-file)?:[ \t]*(.*)/g)) {
                declarations.push({ file, raw: `${match[1] ? 'node-version-file' : 'node-version'}: ${match[2].trim()}` });
            }
        }

        expect(declarations.length).toBeGreaterThan(0);
        for (const { file, raw } of declarations) {
            const literal = /^node-version:[ \t]*['"]?(\d+)['"]?$/.exec(raw);
            expect(
                literal,
                `${file} declares "${raw}" — only a bare major literal is checkable here, ` +
                `so update this test if the workflow moves to a matrix or a version file`,
            ).not.toBeNull();
            expect(Number(literal![1]), `${file} sets up Node ${literal![1]}`).toBe(EXPECTED_MAJOR);
        }
    });
});
