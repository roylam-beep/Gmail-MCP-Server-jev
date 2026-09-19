import path from 'path';

/**
 * Most filesystems cap a single path component at 255 bytes. Gmail attachment
 * IDs for larger attachments run to ~500 characters, so a fallback name like
 * `attachment-<id>` overruns that and the write fails with ENAMETOOLONG. The
 * cap is on BYTES, not characters — a name of 200 CJK characters is 600 bytes.
 */
export const MAX_FILENAME_BYTES = 200;

/** Characters that are path separators or illegal in a filename on Windows. */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Device names Windows refuses to use as a filename, with or without extension. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * character. Slicing a Buffer mid-sequence would leave a lone continuation byte
 * and produce a U+FFFD in the name.
 */
function truncateToBytes(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value) <= maxBytes) return value;

    let out = '';
    let used = 0;
    // Iterating the string yields whole code points, so surrogate pairs stay intact.
    for (const char of value) {
        const width = Buffer.byteLength(char);
        if (used + width > maxBytes) break;
        out += char;
        used += width;
    }
    return out;
}

/**
 * Reduce an untrusted filename to a single, safe path component.
 *
 * Handles what `path.basename()` alone does not:
 *  - backslash separators (`..\\..\\evil` is one component to POSIX basename)
 *  - the traversal names `.` and `..`, which basename passes through verbatim
 *  - control characters and characters illegal on Windows
 *  - Windows device names (CON, NUL, COM1, ...)
 *  - leading dots, and trailing dots/spaces that Windows silently strips
 *  - byte-length truncation that keeps the extension and never splits a
 *    multi-byte character
 *
 * Always returns a non-empty name; degenerate input becomes `unnamed`.
 */
export function sanitizeFilename(filename: string): string {
    // Collapse both separator styles first so a Windows-style path cannot
    // survive as a single component on POSIX.
    let name = String(filename ?? '').replace(/\\/g, '/');
    name = path.posix.basename(name);
    name = name.replace(ILLEGAL_FILENAME_CHARS, '_');

    // Windows drops trailing dots and spaces, which would let "evil.txt. "
    // resolve to a different file than the one reported back to the caller.
    name = name.replace(/[. ]+$/, '');
    // A leading dot would hide the file; a leading run of dots is traversal.
    name = name.replace(/^\.+/, '');
    name = name.trim();

    if (!name) return 'unnamed';
    if (WINDOWS_RESERVED_NAMES.test(name)) return `_${name}`;

    if (Buffer.byteLength(name) <= MAX_FILENAME_BYTES) return name;

    // Keep the extension when it is short enough to be meaningful; an
    // absurdly long "extension" is just part of an overlong name.
    const ext = path.extname(name);
    const extBytes = Buffer.byteLength(ext);
    if (extBytes > 0 && extBytes < MAX_FILENAME_BYTES / 2) {
        const stem = name.slice(0, name.length - ext.length);
        const truncatedStem = truncateToBytes(stem, MAX_FILENAME_BYTES - extBytes);
        return (truncatedStem || 'unnamed') + ext;
    }
    return truncateToBytes(name, MAX_FILENAME_BYTES);
}

/**
 * Name used when an attachment part carries no filename of its own. The ID is
 * clipped before it reaches the name so the result is always well within the
 * filesystem limit.
 */
export function fallbackAttachmentName(attachmentId: string): string {
    return sanitizeFilename(`attachment-${String(attachmentId ?? '').slice(0, 16)}`);
}

/**
 * Join `filename` onto `directory` and verify the result stays inside it.
 * Defence in depth: sanitizeFilename() already strips separators, so a path
 * escaping here means a new bypass rather than an expected case.
 *
 * @throws if the resolved path would land outside `directory`
 */
export function resolveWithinDirectory(directory: string, filename: string): string {
    const resolvedDir = path.resolve(directory);
    const fullPath = path.resolve(resolvedDir, filename);
    if (fullPath !== resolvedDir && !fullPath.startsWith(resolvedDir + path.sep)) {
        throw new Error('Invalid filename: path traversal detected');
    }
    return fullPath;
}
