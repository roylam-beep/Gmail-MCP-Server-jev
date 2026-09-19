/**
 * Resolves the optional tool-name prefix that lets multiple instances of this
 * server run side-by-side without their tool names colliding in MCP clients
 * that disambiguate tools by base name.
 *
 * Precedence: `--tool-prefix=<value>` / `--tool-prefix <value>` CLI flag, then
 * the `GMAIL_MCP_TOOL_PREFIX` env var, then empty string (no prefix — the
 * backward-compatible default).
 *
 * Pure function: argv (already sliced past the node binary and script) and the
 * env map are passed in explicitly, so it is unit-testable without spawning the
 * process.
 *
 * @param args - `process.argv.slice(2)`: CLI args past the node binary and script
 * @param env  - environment map (`process.env`)
 * @returns the resolved prefix, or `''` when none is configured
 */
export function resolveToolPrefix(args: string[], env: NodeJS.ProcessEnv): string {
    return validatePrefix(readPrefix(args, env));
}

function readPrefix(args: string[], env: NodeJS.ProcessEnv): string {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg.startsWith('--tool-prefix=')) {
            return arg.slice('--tool-prefix='.length);
        }
        if (arg === '--tool-prefix' && i + 1 < args.length) {
            return args[i + 1] ?? '';
        }
    }
    return env.GMAIL_MCP_TOOL_PREFIX || '';
}

/**
 * MCP tool names must match `^[a-zA-Z0-9_-]{1,128}$`. Nothing validated the
 * prefix, so `--tool-prefix=gmail.` or a stray trailing space produced tool
 * names every client rejects wholesale: the server starts, advertises them,
 * and the user simply sees no tools with nothing anywhere naming the prefix as
 * the reason.
 */
function validatePrefix(prefix: string): string {
    if (prefix && !/^[a-zA-Z0-9_-]+$/.test(prefix)) {
        throw new Error(
            `Invalid tool prefix ${JSON.stringify(prefix)}: MCP tool names allow only letters, ` +
            `digits, "_" and "-". Try "${prefix.replace(/[^a-zA-Z0-9_-]/g, '_')}".`,
        );
    }
    return prefix;
}
