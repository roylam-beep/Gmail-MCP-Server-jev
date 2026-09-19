import { describe, it, expect } from 'vitest';
import { resolveToolPrefix } from './tool-prefix.js';

const NO_ENV: NodeJS.ProcessEnv = {};

describe('resolveToolPrefix', () => {
    describe('default (backward compatibility)', () => {
        it('returns empty string when no args and no env var', () => {
            expect(resolveToolPrefix([], NO_ENV)).toBe('');
        });

        it('returns empty string for unrelated args', () => {
            expect(resolveToolPrefix(['auth', '--scopes=gmail.readonly'], NO_ENV)).toBe('');
        });
    });

    describe('--tool-prefix=<value> form', () => {
        it('parses the value after the equals sign', () => {
            expect(resolveToolPrefix(['--tool-prefix=personal_'], NO_ENV)).toBe('personal_');
        });

        it('treats an empty value as no prefix', () => {
            expect(resolveToolPrefix(['--tool-prefix='], NO_ENV)).toBe('');
        });

        it('finds the flag among other args', () => {
            expect(resolveToolPrefix(['--scopes=gmail.modify', '--tool-prefix=info_'], NO_ENV)).toBe('info_');
        });

        it('splits on the first equals sign only, then rejects the rest', () => {
            // The value is still read as "a=b_" rather than truncated at the
            // second "=", but "=" is not legal in an MCP tool name, so it is
            // now refused instead of producing tool names every client drops.
            expect(() => resolveToolPrefix(['--tool-prefix=a=b_'], NO_ENV))
                .toThrow(/Invalid tool prefix "a=b_"/);
        });
    });

    describe('character validation', () => {
        // MCP tool names are ^[a-zA-Z0-9_-]{1,128}$. Nothing checked, so a
        // prefix like "gmail." or a stray trailing space produced tool names
        // the client rejected wholesale — the user saw no tools and nothing
        // named the prefix as the cause.
        for (const bad of ['work ', 'gmail.', 'my gmail', 'a/b', 'a:b']) {
            it(`rejects ${JSON.stringify(bad)} and suggests a legal form`, () => {
                expect(() => resolveToolPrefix([`--tool-prefix=${bad}`], NO_ENV))
                    .toThrow(/Invalid tool prefix/);
                expect(() => resolveToolPrefix([`--tool-prefix=${bad}`], NO_ENV))
                    .toThrow(/Try "/);
            });
        }

        it('rejects an invalid prefix from the environment too', () => {
            expect(() => resolveToolPrefix([], { GMAIL_MCP_TOOL_PREFIX: 'work ' }))
                .toThrow(/Invalid tool prefix/);
        });

        for (const good of ['personal_', 'info-', 'work123', '']) {
            it(`accepts ${JSON.stringify(good)}`, () => {
                expect(resolveToolPrefix([`--tool-prefix=${good}`], NO_ENV)).toBe(good);
            });
        }
    });

    describe('--tool-prefix <value> (space-separated) form', () => {
        it('parses the value in the next argv slot', () => {
            expect(resolveToolPrefix(['--tool-prefix', 'shared_'], NO_ENV)).toBe('shared_');
        });

        it('falls through when the flag is the final arg with no value', () => {
            expect(resolveToolPrefix(['--tool-prefix'], NO_ENV)).toBe('');
        });
    });

    describe('GMAIL_MCP_TOOL_PREFIX env var fallback', () => {
        it('uses the env var when no CLI flag is present', () => {
            expect(resolveToolPrefix([], { GMAIL_MCP_TOOL_PREFIX: 'envprefix_' })).toBe('envprefix_');
        });

        it('treats an empty env var as no prefix', () => {
            expect(resolveToolPrefix([], { GMAIL_MCP_TOOL_PREFIX: '' })).toBe('');
        });
    });

    describe('precedence', () => {
        it('CLI flag (=form) overrides the env var', () => {
            expect(resolveToolPrefix(['--tool-prefix=cli_'], { GMAIL_MCP_TOOL_PREFIX: 'env_' })).toBe('cli_');
        });

        it('CLI flag (space form) overrides the env var', () => {
            expect(resolveToolPrefix(['--tool-prefix', 'cli_'], { GMAIL_MCP_TOOL_PREFIX: 'env_' })).toBe('cli_');
        });

        it('first --tool-prefix occurrence wins when the flag is repeated', () => {
            expect(resolveToolPrefix(['--tool-prefix=first_', '--tool-prefix=second_'], NO_ENV)).toBe('first_');
        });
    });
});
