/**
 * Helper functions for reply_all email functionality.
 * Extracted for testability.
 */

/**
 * Parses email addresses from a header value.
 * Handles formats like:
 * - "email@example.com"
 * - "Name <email@example.com>"
 * - Multiple addresses separated by commas
 *
 * @param headerValue - The raw header value (e.g., From, To, CC)
 * @returns Array of extracted email addresses
 */
/** An addr-spec with no spaces and exactly one @, which is all a header needs. */
function looksLikeAddress(value: string): boolean {
    return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value);
}

/**
 * Split on separators that are not inside quotes or angle brackets, so a comma
 * inside a display name does not cut an address in half.
 */
function splitAddresses(headerValue: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let depth = 0;

    for (let i = 0; i < headerValue.length; i++) {
        const char = headerValue[i];
        if (char === '\\' && i + 1 < headerValue.length) {
            current += char + headerValue[i + 1];
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

export function parseEmailAddresses(headerValue: string): string[] {
    if (!headerValue) return [];

    const emails: string[] = [];

    for (const part of splitAddresses(headerValue)) {
        // The real addr-spec is the LAST bracketed group. Taking the first let
        // a display name decide where a reply went:
        //   "Support <support@paypal.com>" <attacker@evil.example>
        // resolved to support@paypal.com — not the sender. Display names are
        // attacker-controlled on any platform that relays user text, and this
        // is the function that decides where reply_all is addressed.
        const bracketed = [...part.matchAll(/<([^>]*)>/g)].pop();
        const candidate = (bracketed ? bracketed[1] : part).trim();

        // Anything that is not a bare address is display-name debris, not a
        // recipient. It used to be pushed through verbatim, and cc/bcc were
        // never validated downstream, so it landed in the header as-is.
        if (looksLikeAddress(candidate)) {
            emails.push(candidate);
        }
    }

    return emails;
}

/**
 * Filters out the authenticated user's email from a list of emails.
 * Case-insensitive comparison.
 *
 * @param emails - Array of email addresses to filter
 * @param myEmail - The authenticated user's email address
 * @returns Filtered array excluding the user's email
 */
export function filterOutEmail(emails: string[], myEmail: string): string[] {
    const myEmailLower = myEmail.toLowerCase();
    return emails.filter(email => email.toLowerCase() !== myEmailLower);
}

/**
 * Adds "Re: " prefix to a subject if not already present.
 * Case-insensitive check for existing prefix.
 *
 * @param subject - The original email subject
 * @returns Subject with "Re: " prefix
 */
export function addRePrefix(subject: string): string {
    if (subject.toLowerCase().startsWith('re:')) {
        return subject;
    }
    return `Re: ${subject}`;
}

/**
 * Builds the References header for a reply email.
 * Combines original References with original Message-ID.
 *
 * @param originalReferences - The References header from the original email
 * @param originalMessageId - The Message-ID of the original email
 * @returns Combined References header value
 */
export function buildReferencesHeader(originalReferences: string, originalMessageId: string): string {
    if (!originalMessageId) {
        return originalReferences;
    }
    return originalReferences ? `${originalReferences} ${originalMessageId}` : originalMessageId;
}

/**
 * Builds recipient lists for a reply-all email.
 *
 * Rules:
 * - TO: original From (sender of the email)
 * - CC: original To + original CC (excluding the authenticated user)
 *
 * @param originalFrom - From header value
 * @param originalTo - To header value
 * @param originalCc - CC header value
 * @param myEmail - The authenticated user's email address
 * @returns Object with 'to' and 'cc' arrays
 */
export function buildReplyAllRecipients(
    originalFrom: string,
    originalTo: string,
    originalCc: string,
    myEmail: string
): { to: string[]; cc: string[] } {
    const fromEmails = parseEmailAddresses(originalFrom);
    const toEmails = parseEmailAddresses(originalTo);
    const ccEmails = parseEmailAddresses(originalCc);

    // TO recipients: original From (the person who sent the email), excluding myself
    let replyTo = dedupe(filterOutEmail(fromEmails, myEmail));

    // CC recipients: everyone else who was on To and CC, excluding myself
    let replyCc = dedupe(filterOutEmail([...toEmails, ...ccEmails], myEmail));

    // Replying to a message you sent yourself is ordinary — the last message
    // in a thread is often your own, and some lists rewrite From to the
    // subscriber. That left `to` empty and the caller reported "Could not
    // determine recipient for reply" on a message that plainly had recipients,
    // because they were all sitting in cc. Promote them.
    if (replyTo.length === 0 && replyCc.length > 0) {
        replyTo = replyCc;
        replyCc = [];
    }

    // An address on both To and Cc otherwise got two copies of the reply.
    const inTo = new Set(replyTo.map(e => e.toLowerCase()));
    replyCc = replyCc.filter(e => !inTo.has(e.toLowerCase()));

    return {
        to: replyTo,
        cc: replyCc
    };
}

/** Case-insensitive de-duplication, preserving first-seen order. */
function dedupe(emails: string[]): string[] {
    const seen = new Set<string>();
    return emails.filter(email => {
        const key = email.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
