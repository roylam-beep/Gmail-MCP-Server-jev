import fs from 'fs';
import path from 'path';

/** Owner-only file mode for anything holding OAuth material. */
export const SECRET_FILE_MODE = 0o600;
/** Owner-only directory mode for the config directory. */
export const SECRET_DIR_MODE = 0o700;

/**
 * Create the directory holding `filePath` if it is missing, with owner-only
 * permissions.
 *
 * The old start-up path created ~/.gmail-mcp only when NEITHER
 * GMAIL_OAUTH_PATH nor GMAIL_CREDENTIALS_PATH was set, so overriding just one
 * of them left the other pointing into a directory nobody created and the
 * first token write failed with ENOENT. Deriving the directory from the path
 * actually in use covers every combination.
 */
export function ensureSecureDirFor(filePath: string): void {
    const dir = path.dirname(path.resolve(filePath));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
    }
}

/**
 * Tighten an existing file to owner-only.
 *
 * fs.writeFileSync's `mode` option applies only when the file is CREATED. A
 * credentials.json written before this fix — or copied in with a umask of 022
 * — stays world-readable forever, and every later write silently preserves
 * those permissions. Chmod explicitly instead of assuming.
 *
 * Best-effort: filesystems without POSIX permissions (Windows, some network
 * mounts) throw here and that must not abort authentication.
 *
 * @returns true when the mode was changed
 */
export function hardenFilePermissions(filePath: string): boolean {
    try {
        const stats = fs.statSync(filePath);
        const mode = stats.mode & 0o777;
        if (mode === SECRET_FILE_MODE) return false;
        fs.chmodSync(filePath, SECRET_FILE_MODE);
        return true;
    } catch {
        return false;
    }
}

/**
 * Write `contents` to `filePath` atomically, owner-only.
 *
 * A plain writeFileSync truncates the target first: a crash, a full disk, or
 * two processes writing at once (the token-refresh handler fires from a timer)
 * leaves a truncated credentials.json, and the next start fails to parse it —
 * the refresh token is gone and the user has to re-authenticate.
 *
 * Writing to a temp file in the same directory, fsync'ing it, then rename()ing
 * over the target makes the replacement atomic: a reader sees either the old
 * complete file or the new one, never a partial write.
 */
export function writeSecretFileAtomic(filePath: string, contents: string): void {
    const resolved = path.resolve(filePath);
    ensureSecureDirFor(resolved);

    const dir = path.dirname(resolved);
    const tempPath = path.join(
        dir,
        `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`,
    );

    // 'wx' fails rather than clobbering an existing temp file; the mode argument
    // applies because this call always creates the file.
    const fd = fs.openSync(tempPath, 'wx', SECRET_FILE_MODE);
    try {
        fs.writeFileSync(fd, contents, 'utf8');
        // Flush to disk before the rename, so the rename cannot land while the
        // temp file's contents are still only in the page cache.
        fs.fsyncSync(fd);
    } catch (error) {
        fs.closeSync(fd);
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
        throw error;
    }
    fs.closeSync(fd);

    try {
        // 'wx' honored the mode, but a restrictive umask is the only thing that
        // could have loosened it — set it explicitly regardless.
        fs.chmodSync(tempPath, SECRET_FILE_MODE);
        fs.renameSync(tempPath, resolved);
    } catch (error) {
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
        throw error;
    }
}

/**
 * Serialize `value` as JSON and write it atomically with owner-only permissions.
 */
export function writeSecretJsonAtomic(filePath: string, value: unknown): void {
    writeSecretFileAtomic(filePath, JSON.stringify(value, null, 2));
}
