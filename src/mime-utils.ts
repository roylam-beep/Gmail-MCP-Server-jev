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
 */
export function parseCharset(contentType: string | undefined): string | undefined {
    if (!contentType) return undefined;
    const match = /;\s*charset\s*=\s*("([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(contentType);
    const raw = match?.[2] ?? match?.[3] ?? match?.[4];
    return raw ? raw.trim().toLowerCase() : undefined;
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
