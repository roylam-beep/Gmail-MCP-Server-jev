import { sanitizeFilename, fallbackAttachmentName } from './filename-utils.js';
import type { EmailAttachment } from './email-export.js';

/**
 * Hard ceiling on how deep a MIME tree is walked.
 *
 * Every traversal here was unbounded recursion over attacker-supplied
 * structure: an inbound message with a few thousand nested multipart/* levels
 * overflows the call stack and kills the process, which for a stdio MCP server
 * means the client loses the session. Real mail nests a handful of levels;
 * 32 leaves a wide margin.
 */
export const MAX_MIME_DEPTH = 32;

export interface GmailMessagePart {
    partId?: string;
    mimeType?: string;
    filename?: string;
    headers?: Array<{
        name: string;
        value: string;
    }>;
    body?: {
        attachmentId?: string;
        size?: number;
        data?: string;
    };
    parts?: GmailMessagePart[];
}

export interface EmailContent {
    text: string;
    html: string;
}

/** Read a header off a MIME part, case-insensitively. */
export function getPartHeader(part: GmailMessagePart, name: string): string | undefined {
    return (part.headers || []).find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Pull the charset parameter out of a Content-Type header.
 * `text/plain; charset="Big5"` -> `big5`
 *
 * Walks the parameters instead of regex-scanning for the first `charset=`.
 * A scan cannot see quoted-string values, so a sender could hide a decoy in
 * one: `text/plain; name="a; charset=utf-16le; b"; charset=utf-8` matched the
 * decoy and decoded a UTF-8 body as UTF-16LE. The `Content-Type` of an inbound
 * part is chosen by whoever sent the mail, so that was remotely triggerable
 * mojibake in read_email, get_thread and the file download_email writes.
 */
export function parseCharset(contentType: string | undefined): string | undefined {
    if (!contentType) return undefined;

    let charset: string | undefined;
    let i = contentType.indexOf(';');
    if (i === -1) return undefined;

    while (i < contentType.length) {
        i += 1; // step past the ';'
        while (i < contentType.length && /\s/.test(contentType[i])) i += 1;

        const attributeStart = i;
        while (i < contentType.length && contentType[i] !== '=' && contentType[i] !== ';') i += 1;
        const attribute = contentType.slice(attributeStart, i).trim().toLowerCase();

        if (contentType[i] === '=') {
            i += 1;
            while (i < contentType.length && /\s/.test(contentType[i])) i += 1;

            let value: string;
            const quote = contentType[i];
            if (quote === '"' || quote === "'") {
                i += 1;
                let quoted = '';
                while (i < contentType.length && contentType[i] !== quote) {
                    if (contentType[i] === '\\' && i + 1 < contentType.length) i += 1;
                    quoted += contentType[i];
                    i += 1;
                }
                i += 1; // step past the closing quote
                value = quoted;
            } else {
                const valueStart = i;
                while (i < contentType.length && contentType[i] !== ';') i += 1;
                value = contentType.slice(valueStart, i).trim();
            }

            if (attribute === 'charset' && value) charset = value.toLowerCase();
        }

        // Skip anything left before the next parameter separator.
        while (i < contentType.length && contentType[i] !== ';') i += 1;
    }

    return charset;
}

/**
 * Decode a part's base64url body using the charset it declares.
 *
 * The decoder was hardcoded to UTF-8, so any message in Big5, Shift_JIS,
 * GB18030, KOI8-R or a Latin-1 variant — still common in mail — came back as
 * mojibake, and that mojibake was what read_email returned and download_email
 * wrote to disk. Unknown or unsupported labels fall back to UTF-8, which is
 * what the old behaviour was for everything.
 */
export function decodePartBody(part: GmailMessagePart): string {
    const data = part.body?.data;
    if (!data) return '';

    // Gmail returns base64url ('-' and '_'); decoding it as plain base64 is
    // lenient in Node but explicit is better.
    const buffer = Buffer.from(data, 'base64url');
    // part.mimeType carries only the type ("text/plain"); the charset parameter
    // lives on the part's own Content-Type header.
    const charset = parseCharset(getPartHeader(part, 'content-type'));

    if (!charset || charset === 'utf-8' || charset === 'utf8') {
        return buffer.toString('utf8');
    }

    try {
        // TextDecoder resolves the WHATWG encoding labels (big5, shift_jis,
        // gbk, windows-1252, iso-8859-1, ...) that show up in mail headers.
        return new TextDecoder(charset, { fatal: false }).decode(buffer);
    } catch {
        // Unknown label: UTF-8 is no worse than the old unconditional behaviour.
        return buffer.toString('utf8');
    }
}

/**
 * Walk a MIME tree depth-first, calling `visit` on every part, stopping at
 * MAX_MIME_DEPTH.
 */
export function walkParts(
    root: GmailMessagePart | null | undefined,
    visit: (part: GmailMessagePart, depth: number) => void,
): void {
    const descend = (part: GmailMessagePart | null | undefined, depth: number): void => {
        if (!part || depth > MAX_MIME_DEPTH) return;
        visit(part, depth);
        for (const child of part.parts || []) {
            descend(child, depth + 1);
        }
    };
    descend(root, 0);
}

/**
 * Recursively extract email body content from MIME message parts.
 * Handles complex email structures with nested parts.
 */
export function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
    let textContent = '';
    let htmlContent = '';

    walkParts(messagePart, (part) => {
        if (!part.body?.data) return;
        const content = decodePartBody(part);
        if (part.mimeType === 'text/plain') {
            textContent += content;
        } else if (part.mimeType === 'text/html') {
            htmlContent += content;
        }
    });

    return { text: textContent, html: htmlContent };
}

/**
 * Extract attachment metadata from a Gmail message payload.
 *
 * Filenames are sanitized here rather than at the download site so the name
 * reported to the caller is the name that would actually be written.
 */
export function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
    const attachments: EmailAttachment[] = [];

    walkParts(payload, (part) => {
        const attachmentId = part.body?.attachmentId;
        if (!attachmentId) return;
        attachments.push({
            id: attachmentId,
            filename: part.filename
                ? sanitizeFilename(part.filename)
                : fallbackAttachmentName(attachmentId),
            mimeType: part.mimeType || 'application/octet-stream',
            size: part.body?.size || 0,
        });
    });

    return attachments;
}

/**
 * Find the filename of the part carrying `attachmentId`, or undefined.
 */
export function findAttachmentFilename(
    payload: GmailMessagePart | null | undefined,
    attachmentId: string,
): string | undefined {
    let found: string | undefined;
    walkParts(payload, (part) => {
        if (found !== undefined) return;
        if (part.body?.attachmentId === attachmentId) {
            found = part.filename || fallbackAttachmentName(attachmentId);
        }
    });
    return found;
}
