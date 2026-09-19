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
 * Strip dots and whitespace from both edges.
 *
 * The strips and the trim used to be separate steps — `/[. ]+$/`, `/^\.+/`,
 * then `trim()`. `trim()` removes the whole Unicode whitespace set while the
 * character classes only covered ASCII space, so a single NBSP defeated both:
 * `'\u00A0..\u00A0'` came back as `'..'` and `' .bashrc'` as `'.bashrc'` —
 * a hidden dotfile named by whoever sent the email. One class covering dots
 * and every Unicode space closes that, and needs no second pass because it
 * leaves nothing at either edge for one to find.
 */
function stripEdges(value: string): string {
    return value.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
}

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
    // resolve to a different file than the one reported back to the caller; a
    // leading dot hides the file and a leading run of dots is traversal.
    name = stripEdges(name);

    if (!name) return 'unnamed';
    // Prefix rather than return: the reserved-name pattern accepts an extension
    // of any length, so returning here would skip the byte cap below and a
    // name like `CON.` + 500 characters would still hit ENAMETOOLONG. The
    // prefix also costs a byte, which the cap has to account for.
    if (WINDOWS_RESERVED_NAMES.test(name)) {
        name = `_${name}`;
    }

    if (Buffer.byteLength(name) <= MAX_FILENAME_BYTES) return name;

    // Keep the extension when it is short enough to be meaningful; an
    // absurdly long "extension" is just part of an overlong name.
    const ext = path.extname(name);
    const extBytes = Buffer.byteLength(ext);
    // Truncation can land on a dot or a space, re-introducing exactly what the
    // strip above removed — so strip again on the way out of every branch.
    if (extBytes > 0 && extBytes < MAX_FILENAME_BYTES / 2) {
        const stem = name.slice(0, name.length - ext.length);
        const truncatedStem = truncateToBytes(stem, MAX_FILENAME_BYTES - extBytes);
        return (stripEdges(truncatedStem) || 'unnamed') + ext;
    }
    return stripEdges(truncateToBytes(name, MAX_FILENAME_BYTES)) || 'unnamed';
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
    const relative = path.relative(resolvedDir, fullPath);

    // A prefix comparison against `resolvedDir + path.sep` rejects every
    // filename when `directory` is a filesystem root: path.resolve('/') is '/',
    // so the prefix becomes '//' and '/a.txt' does not start with it. It also
    // has to carve out an exemption for a path equal to the directory itself,
    // which is never a valid destination for a file write — writing there hits
    // EISDIR. path.relative() answers both cleanly: empty means the path IS
    // the directory, '..' means it escaped, absolute means a different root.
    const escapes = relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative);
    if (!relative || escapes) {
        throw new Error('Invalid filename: path traversal detected');
    }
    return fullPath;
}
