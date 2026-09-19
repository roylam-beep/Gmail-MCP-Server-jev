/**
 * Email export utilities for converting Gmail messages to various formats
 */

import emailAddresses from "email-addresses";

// Types
export interface ParsedAddress {
    name: string;
    email: string;
}

export interface EmailAttachment {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
}

export interface EmailJson {
    messageId: string;
    threadId: string;
    subject: string;
    from: ParsedAddress;
    to: ParsedAddress[];
    cc: ParsedAddress[];
    bcc: ParsedAddress[];
    date: string;
    labels: string[];
    snippet: string;
    body: {
        plain: string;
        html: string;
    };
    attachments: EmailAttachment[];
    headers: Record<string, string>;
}

/**
 * Parse email address string into name and email components
 * Uses RFC 5322 compliant parser (email-addresses package)
 */
export function parseEmailAddress(address: string): ParsedAddress {
    if (!address) return { name: "", email: "" };

    const parsed = emailAddresses.parseOneAddress(address);
    if (parsed && parsed.type === "mailbox") {
        return {
            name: parsed.name || "",
            email: parsed.address || "",
        };
    }
    return { name: "", email: address.trim() };
}

/**
 * Parse comma-separated list of email addresses
 * Uses RFC 5322 compliant parser (email-addresses package)
 */
/**
 * Split an address list on separators that are not inside quotes or angle
 * brackets, so a comma in a display name does not split an address in half.
 * Semicolons count too: Outlook and Exchange emit them in place of commas.
 */
function splitAddressList(addresses: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let depth = 0;

    for (let i = 0; i < addresses.length; i++) {
        const char = addresses[i];
        if (char === '\\' && i + 1 < addresses.length) {
            current += char + addresses[i + 1];
            i += 1;
            continue;
        }
        if (char === '"') inQuotes = !inQuotes;
        else if (!inQuotes && char === '<') depth += 1;
        else if (!inQuotes && char === '>') depth = Math.max(0, depth - 1);

        if (!inQuotes && depth === 0 && (char === ',' || char === ';')) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Parse a comma-separated list of email addresses.
 *
 * `parseAddressList` is all-or-nothing: it returns null for the WHOLE header
 * if any entry is malformed, so one bad address used to discard every good one
 * and the export simply claimed the message had no recipients — silently, with
 * no error. The three commonest malformed forms in real mail all hit it: an
 * unquoted comma in a display name (`Smith, John <j@x.com>`, which CRM and
 * marketing senders emit constantly), Outlook's semicolon separators, and a
 * trailing comma.
 *
 * Group syntax was lost the same way: `.filter(type === "mailbox")` dropped
 * `Engineering: alice@x.com, bob@y.com;` entirely, members and all, even
 * though the parser had read it correctly.
 */
export function parseEmailAddresses(addresses: string | undefined): ParsedAddress[] {
    if (!addresses) return [];

    const parsed = emailAddresses.parseAddressList(addresses);
    if (parsed) {
        // Flatten groups rather than filtering them out. An empty group
        // (`undisclosed-recipients:;`) correctly contributes nothing.
        return parsed
            .flatMap(entry => entry.type === 'mailbox'
                ? [entry as emailAddresses.ParsedMailbox]
                : ((entry as emailAddresses.ParsedGroup).addresses || []))
            .map(entry => ({
                name: entry.name || "",
                email: entry.address || "",
            }));
    }

    // Strict parse failed: recover per entry rather than losing the lot. A
    // fragment with no "@" is display-name debris from a split, not a
    // recipient, so it is dropped instead of invented.
    return splitAddressList(addresses)
        .filter(part => part.includes('@'))
        .map(parseEmailAddress)
        .filter(a => a.email);
}

/**
 * Convert Gmail API message to structured JSON
 */
export function gmailMessageToJson(
    message: any,
    emailContent: { text: string; html: string },
    attachments: EmailAttachment[]
): EmailJson {
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) =>
        headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    // `date` is documented as ISO-8601, so an unparseable header must not be
    // passed through raw — a consumer calling new Date(json.date) would get
    // Invalid Date from a field that is supposed to be machine-readable. The
    // original header is preserved under headers.Date either way.
    const dateStr = getHeader("date");
    const isoDate = toIsoDate(dateStr);

    return {
        messageId: message.id,
        threadId: message.threadId,
        subject: getHeader("subject"),
        from: parseEmailAddress(getHeader("from")),
        to: parseEmailAddresses(getHeader("to")),
        cc: parseEmailAddresses(getHeader("cc")),
        bcc: parseEmailAddresses(getHeader("bcc")),
        date: isoDate,
        labels: message.labelIds || [],
        snippet: message.snippet || "",
        body: {
            plain: emailContent.text,
            html: emailContent.html,
        },
        attachments,
        headers: {
            // The header as it arrived, so a date the ISO field could not
            // represent is still recoverable from the export.
            Date: dateStr,
            "Message-ID": getHeader("message-id"),
            "In-Reply-To": getHeader("in-reply-to"),
            References: getHeader("references"),
        },
    };
}

const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Convert an RFC 2822 Date header to ISO-8601, or "" when it is not a real date.
 *
 * `new Date()` silently rolls out-of-range components over, so a header of
 * "Sun, 31 Feb 2025 10:00:00 +0000" parsed to 3 March and was exported as an
 * authoritative date. Bogus Date headers are routine in spam and in mail from
 * hand-rolled senders, and anything sorting the export by date placed those
 * messages wrongly. The day-of-month is checked against the month the header
 * itself names, which is plain arithmetic and needs no timezone reasoning.
 */
function toIsoDate(dateStr: string): string {
    if (!dateStr) return "";

    const parsed = new Date(dateStr);
    if (Number.isNaN(parsed.getTime())) return "";

    const match = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(dateStr);
    if (match) {
        const day = Number(match[1]);
        const month = MONTHS[match[2].toLowerCase()];
        const year = Number(match[3]);
        if (month) {
            const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
            if (day < 1 || day > daysInMonth) return "";
        }
    }

    return parsed.toISOString();
}

/**
 * Format address for display
 */
function formatAddress(a: ParsedAddress): string {
    return a.name ? `${a.name} <${a.email}>` : a.email;
}

/**
 * Format list of addresses for display
 */
function formatAddresses(addrs: ParsedAddress[]): string {
    return addrs.map(formatAddress).join(", ");
}

/**
 * Convert email to plain text format
 */
export function emailToTxt(
    message: any,
    emailContent: { text: string; html: string },
    attachments: EmailAttachment[]
): string {
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) =>
        headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    const from = getHeader("from");
    const to = getHeader("to");
    const cc = getHeader("cc");
    const subject = getHeader("subject");
    const date = getHeader("date");

    const lines = [`From: ${from}`, `To: ${to}`];

    if (cc) {
        lines.push(`CC: ${cc}`);
    }

    lines.push(`Subject: ${subject}`);
    lines.push(`Date: ${date}`);
    lines.push("");
    lines.push(emailContent.text || "[No plain text content]");

    if (attachments.length > 0) {
        lines.push("");
        lines.push("---");
        lines.push(`Attachments: ${attachments.map((a) => a.filename).join(", ")}`);
    }

    return lines.join("\n");
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Render an email as HTML, falling back to its plain text.
 *
 * Throwing on a plain-text-only message meant download_email format=html
 * wrote no file at all for the majority of automated mail — CI notifications,
 * git send-email patches, cron output, mailing-list digests, bounce reports.
 * Its sibling emailToTxt already degrades with "[No plain text content]"; the
 * asymmetry was the bug. Nothing is lost by wrapping the text instead.
 */
export function emailToHtml(emailContent: { text: string; html: string }): string {
    if (emailContent.html) return emailContent.html;
    if (emailContent.text) {
        return `<pre style="white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(emailContent.text)}</pre>`;
    }
    return '<p>[This message has no text or HTML content]</p>';
}
