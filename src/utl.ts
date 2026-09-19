import fs from 'fs';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';

/**
 * Upper bound on the decoded size of a base64 `content` inline image. Rejecting
 * oversized payloads before nodemailer buffers them prevents host-process memory
 * exhaustion. File-path images stream and are not subject to this check.
 */
export const MAX_INLINE_IMAGE_CONTENT_BYTES = 10 * 1024 * 1024;

/** RFC 5322 caps a line at 998 characters excluding CRLF. */
const MAX_LINE_LENGTH = 998;

/** RFC 2045 line length for base64-encoded bodies. */
const BASE64_LINE_LENGTH = 76;

/**
 * RFC 2047 caps a header LINE containing encoded-words at 76 characters — not
 * just the encoded-word itself. Sizing the payload from the longest header
 * name this builder emits keeps the first line inside that limit whichever
 * header the value lands in.
 *
 * Budget: 76 - len('In-Reply-To: ') = 63 characters for the word. Minus the
 * '=?UTF-8?B?' + '?=' delimiters (12) leaves 51 for base64, rounded down to a
 * multiple of 4 -> 48 characters -> 36 bytes of input. First line: 13 + 60 = 73.
 */
const ENCODED_WORD_PAYLOAD_BYTES = 36;

function isAscii(text: string): boolean {
    return !/[^\x00-\x7F]/.test(text);
}

/**
 * Split a string into chunks of at most `maxBytes` UTF-8 bytes without cutting
 * a character in half. A split multi-byte sequence would decode to U+FFFD in
 * the recipient's client.
 */
function chunkByBytes(text: string, maxBytes: number): string[] {
    const chunks: string[] = [];
    let current = '';
    let used = 0;

    // Iterating a string yields whole code points, keeping surrogate pairs intact.
    for (const char of text) {
        const width = Buffer.byteLength(char);
        if (used + width > maxBytes) {
            chunks.push(current);
            current = '';
            used = 0;
        }
        current += char;
        used += width;
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [''];
}

/**
 * Emit `Name: value`, folded so no line exceeds the RFC 5322 998-character
 * limit.
 *
 * The limit is on the whole LINE, header name included — a 998-character
 * subject produces a 1007-character `Subject:` line, and a 100-recipient `To:`
 * runs to several thousand. Folding is only legal at existing whitespace, so a
 * single token longer than the budget is emitted as-is; there is nowhere to
 * break it.
 */
function foldHeaderField(name: string, value: string): string {
    const prefix = `${name}:`;
    if (prefix.length + 1 + value.length <= MAX_LINE_LENGTH) {
        return `${prefix} ${value}`;
    }

    const lines: string[] = [];
    let current = prefix;
    for (const token of value.split(' ')) {
        if (current !== prefix && current.length + 1 + token.length > MAX_LINE_LENGTH) {
            lines.push(current);
            // A continuation line begins with folding whitespace.
            current = ` ${token}`;
        } else {
            current += ` ${token}`;
        }
    }
    lines.push(current);
    return lines.join('\r\n');
}

/**
 * Emit a `Subject:` field, RFC 2047 encoded when the value is not ASCII.
 *
 * A long non-ASCII subject used to become one encoded-word of arbitrary
 * length; RFC 2047 caps an encoded-word at 75 characters and the line carrying
 * it at 76, and clients that enforce either render the overflow as literal
 * `=?UTF-8?B?...` text. The value is split into conforming encoded-words
 * folded onto continuation lines. ASCII subjects are folded on whitespace by
 * the shared path rather than returned unfolded.
 */
function encodeSubjectField(text: string): string {
    if (isAscii(text)) return foldHeaderField('Subject', text);

    const words = chunkByBytes(text, ENCODED_WORD_PAYLOAD_BYTES)
        .map(chunk => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);

    // A CRLF + space folds the header; adjacent encoded-words separated by
    // folding whitespace are concatenated without a space by the decoder.
    return `Subject: ${words.join('\r\n ')}`;
}

/**
 * True when `text` can honestly be labelled `Content-Transfer-Encoding: 7bit`.
 *
 * Non-ASCII is 8-bit by definition. RFC 2045 §2.7 additionally forbids NUL and
 * the other C0 controls in a 7bit body, and allows CR and LF only as a CRLF
 * pair — an ASCII-range check alone lets `a\u0000b` through and declares it
 * 7bit. Bare LF is not disqualifying here because the caller's line endings
 * are normalised to CRLF before emission.
 */
function is7BitClean(text: string): boolean {
    if (!isAscii(text)) return false;
    // Everything below 0x20 except TAB, CR and LF, plus DEL.
    return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

/**
 * Pick a Content-Transfer-Encoding that matches the bytes actually being sent.
 *
 * Declaring `7bit` for a UTF-8 body is a lie the recipient's client acts on:
 * every part was labelled `charset=UTF-8; Content-Transfer-Encoding: 7bit`,
 * so any non-ASCII body (CJK, accents, emoji) was transmitted as 8-bit octets
 * under a 7bit declaration. Clients that honour the declaration render mojibake,
 * and strict MTAs may re-encode or reject the message. Lines over the RFC 5322
 * 998-character limit are folded by the same path.
 */
export function encodeBodyPart(content: string): { encoding: string; body: string } {
    const text = content ?? '';
    const tooLong = text.split(/\r?\n/).some(line => line.length > MAX_LINE_LENGTH);

    if (is7BitClean(text) && !tooLong) {
        // The message is assembled with CRLF separators, so a body carrying
        // bare LF would leave mixed line endings inside the part.
        return { encoding: '7bit', body: text.replace(/\r\n|\r|\n/g, '\r\n') };
    }

    const base64 = Buffer.from(text, 'utf8').toString('base64');
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += BASE64_LINE_LENGTH) {
        lines.push(base64.slice(i, i + BASE64_LINE_LENGTH));
    }
    return { encoding: 'base64', body: lines.join('\r\n') };
}

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

/**
 * Sanitize a value destined for an email header to prevent CRLF injection.
 * Strips \r, \n, and \0 characters that could inject additional headers.
 */
function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n\0]/g, '');
}

export function createEmailMessage(validatedArgs: any): string {
    const subjectField = encodeSubjectField(sanitizeHeaderValue(validatedArgs.subject));
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';
    
    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Generate a random boundary string for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

    // Validate every recipient field, not just `to`. cc and bcc went
    // unchecked, so a malformed value — one built by reply_all from a display
    // name, say — landed in the header verbatim.
    for (const [field, values] of [
        ['to', validatedArgs.to],
        ['cc', validatedArgs.cc],
        ['bcc', validatedArgs.bcc],
    ] as Array<[string, string[] | undefined]>) {
        for (const email of values || []) {
            if (!validateEmail(email)) {
                throw new Error(`Recipient email address is invalid in ${field}: ${email}`);
            }
        }
    }

    // Sanitize all user-supplied header values to prevent CRLF injection
    const from = sanitizeHeaderValue(validatedArgs.from || 'me');
    const to = (validatedArgs.to as string[]).map(sanitizeHeaderValue).join(', ');
    const cc = validatedArgs.cc ? (validatedArgs.cc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const bcc = validatedArgs.bcc ? (validatedArgs.bcc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const inReplyTo = validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';
    const references = validatedArgs.references
        ? sanitizeHeaderValue(validatedArgs.references)
        : validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';

    // Common email headers. Every field is folded: the 998-character limit is
    // on the whole line, so the header name counts against it, and an address
    // list of up to 100 recipients runs to several thousand characters.
    const emailParts = [
        foldHeaderField('From', from),
        // A cc-only or bcc-only send has no To: recipients; emitting an empty
        // `To: ` header is malformed, so omit the field entirely.
        to ? foldHeaderField('To', to) : '',
        cc ? foldHeaderField('Cc', cc) : '',
        bcc ? foldHeaderField('Bcc', bcc) : '',
        subjectField,
        inReplyTo ? foldHeaderField('In-Reply-To', inReplyTo) : '',
        references ? foldHeaderField('References', references) : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        const textPart = encodeBodyPart(validatedArgs.body);
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push(`Content-Transfer-Encoding: ${textPart.encoding}`);
        emailParts.push('');
        emailParts.push(textPart.body);
        emailParts.push('');

        // HTML part
        const htmlPart = encodeBodyPart(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push(`Content-Transfer-Encoding: ${htmlPart.encoding}`);
        emailParts.push('');
        emailParts.push(htmlPart.body);
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        const htmlOnly = encodeBodyPart(validatedArgs.htmlBody || validatedArgs.body);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push(`Content-Transfer-Encoding: ${htmlOnly.encoding}`);
        emailParts.push('');
        emailParts.push(htmlOnly.body);
    } else {
        // Plain text email (default)
        const textOnly = encodeBodyPart(validatedArgs.body);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push(`Content-Transfer-Encoding: ${textOnly.encoding}`);
        emailParts.push('');
        emailParts.push(textOnly.body);
    }

    return emailParts.join('\r\n');
}


export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Inline images can only be referenced from an HTML body via cid: URLs.
    const inlineImages = validatedArgs.inlineImages || [];
    if (inlineImages.length > 0 && !validatedArgs.htmlBody) {
        throw new Error('inlineImages require htmlBody — a cid: reference only resolves from HTML content');
    }

    // Prepare attachments for nodemailer
    const attachments: any[] = [];
    for (const filePath of (validatedArgs.attachments || [])) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File does not exist: ${filePath}`);
        }

        const fileName = path.basename(filePath);

        attachments.push({
            filename: fileName,
            path: filePath
        });
    }

    // In-memory parts carried over from another message (forward_email). These
    // never touch the filesystem: the bytes come straight from the Gmail API.
    // A part keeping its `cid` stays inline so cid: references in the quoted
    // HTML body still resolve for the recipient.
    for (const part of (validatedArgs.rawAttachments || [])) {
        const entry: Record<string, unknown> = {
            filename: part.filename,
            content: part.content,
            encoding: 'base64',
        };
        if (part.contentType) {
            entry.contentType = part.contentType;
        }
        if (part.cid) {
            entry.cid = sanitizeHeaderValue(String(part.cid));
        }
        attachments.push(entry);
    }

    // Inline images: nodemailer emits a multipart/related container and sets
    // Content-ID + Content-Disposition: inline for any attachment carrying a `cid`.
    for (const img of inlineImages) {
        // `cid` lands in a Content-ID header — strip CR/LF/NUL as defense in depth
        // on top of the schema-level character restriction.
        const cid = sanitizeHeaderValue(String(img.cid || ''));
        if (!cid) {
            throw new Error('Inline image cid must be a non-empty string');
        }

        const part: Record<string, unknown> = { cid };

        if (img.path) {
            if (!fs.existsSync(img.path)) {
                throw new Error(`Inline image file does not exist: ${img.path}`);
            }
            part.path = img.path;
            part.filename = img.filename || path.basename(img.path);
        } else {
            // Reject oversized base64 payloads before nodemailer buffers them in
            // memory. Estimate decoded size from the base64 length (~3/4 ratio).
            const estimatedBytes = Math.floor((String(img.content || '').length * 3) / 4);
            if (estimatedBytes > MAX_INLINE_IMAGE_CONTENT_BYTES) {
                throw new Error(
                    `Inline image '${cid}' exceeds the ${MAX_INLINE_IMAGE_CONTENT_BYTES / (1024 * 1024)} MB size limit`,
                );
            }
            part.content = img.content;
            part.encoding = 'base64';
            part.filename = img.filename || cid;
        }

        if (img.contentType) {
            part.contentType = img.contentType;
        }

        attachments.push(part);
    }

    const mailOptions = {
        from: validatedArgs.from || 'me', // Gmail API uses default send-as if 'me', or specified alias
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: validatedArgs.htmlBody,
        attachments: attachments,
        inReplyTo: validatedArgs.inReplyTo,
        references: validatedArgs.references || validatedArgs.inReplyTo
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();

    return rawMessage;
}

/**
 * Decide which email builder to use. Messages carrying file attachments,
 * inline images, or parts carried over from a forwarded message need the
 * nodemailer-based raw builder (multipart/mixed and multipart/related); plain
 * or simple HTML mail uses the lightweight createEmailMessage() builder.
 */
export function needsRawBuilder(args: any): boolean {
    const hasAttachments = Array.isArray(args?.attachments) && args.attachments.length > 0;
    const hasInlineImages = Array.isArray(args?.inlineImages) && args.inlineImages.length > 0;
    const hasRawAttachments = Array.isArray(args?.rawAttachments) && args.rawAttachments.length > 0;
    return hasAttachments || hasInlineImages || hasRawAttachments;
}

