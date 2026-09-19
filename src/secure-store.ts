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
        return;
    }

    // An existing directory keeps whatever mode it was created with, so a
    // ~/.gmail-mcp left at 0755 by an older build or a restored backup stays
    // group- and world-traversable and the 0600 files inside it are still
    // enumerable. Same upgrade-path reasoning as hardenFilePermissions, and
    // best-effort for the same reason.
    try {
        if ((fs.statSync(dir).mode & 0o777) !== SECRET_DIR_MODE) {
            fs.chmodSync(dir, SECRET_DIR_MODE);
        }
    } catch { /* filesystems without POSIX permissions */ }
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
 * complete file or the new one, never a partial write. The directory is
 * fsync'd afterwards so the rename itself is durable, not just the contents.
 *
 * Note this replaces a symlink at `filePath` with a regular file rather than
 * writing through it. That is deliberate — writing through a link is how a
 * credential file ends up somewhere the caller did not choose — but it does
 * mean a deliberately symlinked credentials.json is detached on first write.
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

    // Flush the directory entry. Without this the rename can still be lost on
    // a crash, so the file would be atomic but not durable. Best-effort:
    // opening a directory for fsync is not portable.
    try {
        const dirFd = fs.openSync(dir, 'r');
        try {
            fs.fsyncSync(dirFd);
        } finally {
            fs.closeSync(dirFd);
        }
    } catch { /* not supported on this platform */ }
}

/**
 * Serialize `value` as JSON and write it atomically with owner-only permissions.
 */
export function writeSecretJsonAtomic(filePath: string, value: unknown): void {
    writeSecretFileAtomic(filePath, JSON.stringify(value, null, 2));
}
