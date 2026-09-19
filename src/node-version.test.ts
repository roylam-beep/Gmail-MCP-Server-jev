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

    it('Dockerfile builds on the same major', () => {
        const match = read('Dockerfile').match(/^FROM node:(\d+)/m);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBe(EXPECTED_MAJOR);
    });

    it('every workflow sets up the same major', () => {
        const workflowDir = path.join(REPO_ROOT, '.github', 'workflows');
        const workflows = fs.readdirSync(workflowDir).filter(f => /\.ya?ml$/.test(f));
        const versions: Array<{ file: string; version: number }> = [];

        for (const file of workflows) {
            const contents = fs.readFileSync(path.join(workflowDir, file), 'utf8');
            for (const match of contents.matchAll(/node-version:\s*'?"?(\d+)/g)) {
                versions.push({ file, version: Number(match[1]) });
            }
        }

        expect(versions.length).toBeGreaterThan(0);
        for (const { file, version } of versions) {
            expect(version, `${file} sets up Node ${version}`).toBe(EXPECTED_MAJOR);
        }
    });
});
