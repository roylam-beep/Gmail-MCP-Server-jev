import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Schema bounds
// -------------
// Every externally supplied value is bounded. Unbounded numbers reached loop
// counters directly (batchSize: 0 spun processBatches forever; a negative or
// fractional maxResults silently returned nothing), and unbounded arrays let a
// single tool call fan out into thousands of Gmail API requests.
//
// The helpers below are FACTORIES, not shared instances. Reusing one zod
// object across fields makes zodToJsonSchema deduplicate by identity and emit
// `$ref` — and JSON Schema draft-07, which these schemas declare, requires
// keywords beside a `$ref` to be ignored. The per-field `description` was
// therefore dropped and the model read the target's instead, so
// `removeLabelIds` documented itself as "label IDs to apply" and `bcc` as
// "List of CC recipients". A fresh instance per field keeps each description.
const MAX_ID_LENGTH = 512;
// Gmail attachment IDs are long opaque base64url blobs, routinely 600+
// characters — capping them at MAX_ID_LENGTH made download_attachment
// unusable for exactly the large attachments it exists to fetch.
const MAX_ATTACHMENT_ID_LENGTH = 4096;
const MAX_EMAIL_LENGTH = 320; // RFC 5321 local-part + domain ceiling
const MAX_RECIPIENTS = 100;
const MAX_MESSAGE_IDS = 1000; // Gmail batchModify/batchDelete cap
const MAX_LABEL_IDS = 100;
const MAX_ATTACHMENTS = 25;
const MAX_INLINE_IMAGES = 50;
const MAX_QUERY_LENGTH = 2048;
// Header values are folded before emission, so this bounds the value itself
// rather than the wire line; see foldHeaderField() in utl.ts.
const MAX_SUBJECT_LENGTH = 998;
const MAX_MESSAGE_ID_HEADER_LENGTH = 998;
const MAX_BODY_LENGTH = 10 * 1024 * 1024;
// The decoded ceiling enforced in utl.ts is 10 MiB. `content` is base64, which
// is 4 characters per 3 bytes — bounding the STRING at 10 MiB capped decoded
// images at 7.5 MiB and made the decoded guard unreachable from any tool path.
const MAX_INLINE_IMAGE_BASE64_LENGTH = Math.ceil((10 * 1024 * 1024) / 3) * 4;
const MAX_PATH_LENGTH = 4096;
const MAX_FILENAME_LENGTH = 255;
const MAX_BATCH_SIZE = 100;
const MAX_PAGE_SIZE = 500; // Gmail maxResults ceiling

const idString = () => z.string().min(1).max(MAX_ID_LENGTH);
const attachmentIdString = () => z.string().min(1).max(MAX_ATTACHMENT_ID_LENGTH);
const emailString = () => z.string().min(1).max(MAX_EMAIL_LENGTH);
const bodyString = () => z.string().max(MAX_BODY_LENGTH);
const subjectString = () => z.string().max(MAX_SUBJECT_LENGTH);
const messageIdHeaderString = () => z.string().min(1).max(MAX_MESSAGE_ID_HEADER_LENGTH);
const queryString = () => z.string().max(MAX_QUERY_LENGTH);
const pathString = () => z.string().min(1).max(MAX_PATH_LENGTH);
const labelNameString = () => z.string().min(1).max(MAX_FILENAME_LENGTH);
const labelIdArray = () => z.array(idString()).max(MAX_LABEL_IDS);
const recipientArray = () => z.array(emailString()).max(MAX_RECIPIENTS);
const messageIdArray = () => z.array(idString()).min(1).max(MAX_MESSAGE_IDS);
const attachmentPathArray = () => z.array(pathString()).max(MAX_ATTACHMENTS);
const batchSizeNumber = () => z.number().int().min(1).max(MAX_BATCH_SIZE);
const pageSizeNumber = () => z.number().int().min(1).max(MAX_PAGE_SIZE);
const byteSizeNumber = () => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * A message needs at least one recipient somewhere — but a cc-only send and a
 * bcc-only broadcast are both legitimate, so requiring `to` to be non-empty
 * blocked them outright. Check across the three fields instead.
 */
const hasAnyRecipient = (d: { to?: string[]; cc?: string[]; bcc?: string[] }) =>
  (d.to?.length ?? 0) + (d.cc?.length ?? 0) + (d.bcc?.length ?? 0) > 0;

const RECIPIENT_REQUIRED = {
  message: 'At least one recipient is required across `to`, `cc` and `bcc`',
  path: ['to'],
};

// Schema definitions

// Inline image embedded in an HTML body and referenced via a cid: URL.
// Exactly one of `path` / `content` must be set; `contentType` is required with `content`.
export const InlineImageSchema = z.object({
  cid: z.string().min(1).max(MAX_ID_LENGTH).regex(/^[^\s<>]+$/, "cid must not contain whitespace or angle brackets")
    .describe("Content-ID for the image, referenced from htmlBody as <img src=\"cid:CID\">"),
  path: pathString().optional().describe("Absolute file path to the image (use this OR content)"),
  content: z.string().max(MAX_INLINE_IMAGE_BASE64_LENGTH).optional().describe("Base64-encoded image data (use this OR path)"),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon']).optional()
    .describe("Image MIME type — required when using `content`. SVG is intentionally unsupported."),
  filename: z.string().min(1).max(MAX_FILENAME_LENGTH).optional().describe("Display filename for the image part (defaults derived from path or cid)"),
})
  .refine(d => (d.path ? 1 : 0) + (d.content ? 1 : 0) === 1, {
    message: "Each inline image must set exactly one of `path` or `content`",
  })
  .refine(d => !d.content || !!d.contentType, {
    message: "`contentType` is required when an inline image uses `content`",
  });

const inlineImageArray = () => z.array(InlineImageSchema).max(MAX_INLINE_IMAGES);

export const SendEmailSchema = z.object({
  to: recipientArray().optional().default([]).describe("List of recipient email addresses (may be empty for a cc-only or bcc-only send)"),
  subject: subjectString().describe("Email subject"),
  body: bodyString().describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: emailString().optional().describe("Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified."),
  htmlBody: bodyString().optional().describe("HTML version of the email body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  cc: recipientArray().optional().describe("List of CC recipients"),
  bcc: recipientArray().optional().describe("List of BCC recipients"),
  threadId: idString().optional().describe("Thread ID to reply to"),
  inReplyTo: messageIdHeaderString().optional().describe("Message ID being replied to"),
  attachments: attachmentPathArray().optional().describe("List of file paths to attach to the email"),
  inlineImages: inlineImageArray().optional().describe("Images embedded inline in the HTML body, each referenced from htmlBody as <img src=\"cid:CID\">. Requires htmlBody to be set."),
}).refine(hasAnyRecipient, RECIPIENT_REQUIRED);

export const ReadEmailSchema = z.object({
  messageId: idString().describe("ID of the email message to retrieve"),
});

export const SearchEmailsSchema = z.object({
  query: queryString().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
  maxResults: pageSizeNumber().optional().describe("Maximum number of results to return (1-500, default: 10)"),
});

export const ModifyEmailSchema = z.object({
  messageId: idString().describe("ID of the email message to modify"),
  labelIds: labelIdArray().optional().describe("List of label IDs to apply"),
  addLabelIds: labelIdArray().optional().describe("List of label IDs to add to the message"),
  removeLabelIds: labelIdArray().optional().describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
  messageId: idString().describe("ID of the email message to delete"),
});

// Draft lifecycle schemas
export const SendDraftSchema = z.object({
  draftId: idString().describe("ID of the draft to send (returned by draft_email)"),
});

export const DeleteDraftSchema = z.object({
  draftId: idString().describe("ID of the draft to delete"),
});

export const UpdateDraftSchema = z.object({
  draftId: idString().describe("ID of the draft to update"),
  to: recipientArray().optional().default([]).describe("List of recipient email addresses (may be empty for a cc-only or bcc-only send)"),
  subject: subjectString().describe("Email subject"),
  body: bodyString().describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: emailString().optional().describe("Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified."),
  htmlBody: bodyString().optional().describe("HTML version of the email body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  cc: recipientArray().optional().describe("List of CC recipients"),
  bcc: recipientArray().optional().describe("List of BCC recipients"),
  threadId: idString().optional().describe("Thread ID to reply to"),
  inReplyTo: messageIdHeaderString().optional().describe("Message ID being replied to"),
  attachments: attachmentPathArray().optional().describe("List of file paths to attach to the email"),
  inlineImages: inlineImageArray().optional().describe("Images embedded inline in the HTML body, each referenced from htmlBody as <img src=\"cid:CID\">. Requires htmlBody to be set."),
}).refine(hasAnyRecipient, RECIPIENT_REQUIRED);

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z.object({
  name: labelNameString().describe("Name for the new label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Creates a new Gmail label");

export const UpdateLabelSchema = z.object({
  id: idString().describe("ID of the label to update"),
  name: labelNameString().optional().describe("New name for the label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z.object({
  id: idString().describe("ID of the label to delete"),
}).describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z.object({
  name: labelNameString().describe("Name of the label to get or create"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Gets an existing label by name or creates it if it doesn't exist");

export const BatchModifyEmailsSchema = z.object({
  messageIds: messageIdArray().describe("List of message IDs to modify"),
  addLabelIds: labelIdArray().optional().describe("List of label IDs to add to all messages"),
  removeLabelIds: labelIdArray().optional().describe("List of label IDs to remove from all messages"),
  batchSize: batchSizeNumber().optional().default(50).describe("Number of messages to process in each batch (1-100, default: 50)"),
});

export const ReportPhishingSchema = z.object({
  messageId: idString().describe("ID of the email message to report as phishing"),
}).describe("Reports a message as phishing using the closest public Gmail API behavior by applying the SPAM label");

export const BatchReportPhishingSchema = z.object({
  messageIds: messageIdArray().describe("List of message IDs to report as phishing"),
  batchSize: batchSizeNumber().optional().default(50).describe("Number of messages to process in each batch (1-100, default: 50)"),
}).describe("Reports multiple messages as phishing using the closest public Gmail API behavior by applying the SPAM label");

export const BatchDeleteEmailsSchema = z.object({
  messageIds: messageIdArray().describe("List of message IDs to delete"),
  batchSize: batchSizeNumber().optional().default(50).describe("Number of messages to process in each batch (1-100, default: 50)"),
});

export const CreateFilterSchema = z.object({
  criteria: z.object({
    from: z.string().max(MAX_QUERY_LENGTH).optional().describe("Sender email address to match"),
    to: z.string().max(MAX_QUERY_LENGTH).optional().describe("Recipient email address to match"),
    subject: subjectString().optional().describe("Subject text to match"),
    query: queryString().optional().describe("Gmail search query (e.g., 'has:attachment')"),
    negatedQuery: queryString().optional().describe("Text that must NOT be present"),
    hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
    excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
    size: byteSizeNumber().optional().describe("Email size in bytes"),
    sizeComparison: z.enum(['unspecified', 'smaller', 'larger']).optional().describe("Size comparison operator")
  }).describe("Criteria for matching emails"),
  action: z.object({
    addLabelIds: labelIdArray().optional().describe("Label IDs to add to matching emails"),
    removeLabelIds: labelIdArray().optional().describe("Label IDs to remove from matching emails"),
    forward: emailString().optional().describe("Email address to forward matching emails to")
  }).describe("Actions to perform on matching emails")
}).describe("Creates a new Gmail filter");

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z.object({
  filterId: idString().describe("ID of the filter to retrieve")
}).describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z.object({
  filterId: idString().describe("ID of the filter to delete")
}).describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z.object({
  template: z.enum(['fromSender', 'withSubject', 'withAttachments', 'largeEmails', 'containingText', 'mailingList']).describe("Pre-defined filter template to use"),
  parameters: z.object({
    senderEmail: emailString().optional().describe("Sender email (for fromSender template)"),
    subjectText: subjectString().optional().describe("Subject text (for withSubject template)"),
    searchText: queryString().optional().describe("Text to search for (for containingText template)"),
    listIdentifier: z.string().min(1).max(MAX_QUERY_LENGTH).optional().describe("Mailing list identifier (for mailingList template)"),
    sizeInBytes: byteSizeNumber().optional().describe("Size threshold in bytes (for largeEmails template)"),
    labelIds: labelIdArray().optional().describe("Label IDs to apply"),
    archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
    markAsRead: z.boolean().optional().describe("Whether to mark as read"),
    markImportant: z.boolean().optional().describe("Whether to mark as important")
  }).describe("Template-specific parameters")
}).describe("Creates a filter using a pre-defined template");

export const DownloadAttachmentSchema = z.object({
  messageId: idString().describe("ID of the email message containing the attachment"),
  attachmentId: attachmentIdString().describe("ID of the attachment to download"),
  filename: z.string().min(1).max(MAX_FILENAME_LENGTH).optional().describe("Filename to save the attachment as (if not provided, uses original filename)"),
  savePath: pathString().optional().describe("Directory path to save the attachment (defaults to current directory)"),
});

export const DownloadEmailSchema = z.object({
  messageId: idString().describe("ID of the email message to download"),
  savePath: pathString().describe("Directory path to save the email file"),
  format: z.enum(['json', 'eml', 'txt', 'html']).optional().default('json')
    .describe("Output format: json (structured data), eml (raw RFC822), txt (plain text), html (formatted HTML)"),
});

export const ModifyThreadSchema = z.object({
  threadId: idString().describe("ID of the Gmail thread to modify"),
  addLabelIds: labelIdArray().optional().describe("List of label IDs to add to all messages in the thread"),
  removeLabelIds: labelIdArray().optional().describe("List of label IDs to remove from all messages in the thread"),
});

// Thread-level schemas
export const GetThreadSchema = z.object({
  threadId: idString().describe("ID of the email thread to retrieve"),
  format: z.enum(['full', 'metadata', 'minimal']).optional().default('full').describe("Format of the email messages returned (default: full)"),
});

export const ListInboxThreadsSchema = z.object({
  query: queryString().optional().default('in:inbox').describe("Gmail search query (default: 'in:inbox')"),
  maxResults: pageSizeNumber().optional().default(50).describe("Maximum number of threads to return (1-500, default: 50)"),
});

export const GetInboxWithThreadsSchema = z.object({
  query: queryString().optional().default('in:inbox').describe("Gmail search query (default: 'in:inbox')"),
  maxResults: pageSizeNumber().optional().default(50).describe("Maximum number of threads to return (1-500, default: 50)"),
  expandThreads: z.boolean().optional().default(true).describe("Whether to fetch full thread content for each thread (default: true)"),
});

// Reply All schema - fetches original email and builds recipient list automatically
export const ReplyAllSchema = z.object({
  messageId: idString().describe("ID of the email message to reply to"),
  body: bodyString().describe("Reply body content (used for text/plain or when htmlBody not provided)"),
  htmlBody: bodyString().optional().describe("HTML version of the reply body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  attachments: attachmentPathArray().optional().describe("List of file paths to attach to the reply"),
  inlineImages: inlineImageArray().optional().describe("Images embedded inline in the HTML body, each referenced from htmlBody as <img src=\"cid:CID\">. Requires htmlBody to be set."),
});

// Forward schema - fetches the original email and re-sends it to new recipients
export const ForwardEmailSchema = z.object({
  messageId: idString().describe("ID of the email message to forward"),
  to: recipientArray().optional().default([]).describe("List of recipient email addresses to forward to (may be empty for a cc-only or bcc-only forward)"),
  cc: recipientArray().optional().describe("List of CC recipients"),
  bcc: recipientArray().optional().describe("List of BCC recipients"),
  from: emailString().optional().describe("Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified."),
  body: bodyString().optional().describe("Optional note placed above the quoted original message"),
  htmlBody: bodyString().optional().describe("HTML version of the optional note. Only used when the original message has an HTML body."),
  includeAttachments: z.boolean().optional().default(true).describe("Carry the original message's attachments and inline images over to the forwarded copy"),
}).refine(hasAnyRecipient, RECIPIENT_REQUIRED);

// Triage (rule-based mail sorting) schemas
// ----------------------------------------
// Gmail's own filters only apply to incoming mail. These rules are the
// retroactive half: the same kind of condition, matched locally against
// messages a query already selected. Header-only — no body is ever fetched.
const MAX_TRIAGE_MESSAGES = 500;
const MAX_TRIAGE_RULES = 200;
const MAX_CONDITION_VALUES = 50;
const MAX_RUN_ID_LENGTH = 128;

const conditionValueArray = () => z.array(z.string().min(1).max(MAX_EMAIL_LENGTH)).max(MAX_CONDITION_VALUES);
const triageLabelArray = () => z.array(labelNameString()).max(MAX_LABEL_IDS);
const runIdString = () => z.string().min(1).max(MAX_RUN_ID_LENGTH).regex(
  /^[A-Za-z0-9._-]+$/,
  "run id may contain only letters, digits, dot, underscore and hyphen",
);

export const TriageConditionsSchema = z.object({
  fromEquals: conditionValueArray().optional().describe("Exact sender addresses, case-insensitive"),
  fromDomain: conditionValueArray().optional().describe("Sender domains; matches the domain and any subdomain of it"),
  fromContains: conditionValueArray().optional().describe("Substrings of the sender display name or address"),
  subjectContains: conditionValueArray().optional().describe("Substrings of the subject, case-insensitive"),
  listIdContains: conditionValueArray().optional().describe("Substrings of the List-Id header — the reliable way to catch one mailing list"),
  hasListUnsubscribe: z.boolean().optional().describe("true matches bulk mail carrying List-Unsubscribe; false matches mail without it"),
  hasLabel: conditionValueArray().optional().describe("Label names the message already carries (any of)"),
  lacksLabel: conditionValueArray().optional().describe("Label names the message must NOT carry (all of) — use it to keep a rule from re-running"),
});

export const TriageActionsSchema = z.object({
  addLabels: triageLabelArray().describe("Label NAMES to apply; created on demand when the plan is applied"),
  removeLabels: triageLabelArray().optional().describe("Label names to remove"),
  archive: z.boolean().optional().describe("Remove the INBOX label"),
  markRead: z.boolean().optional().describe("Remove the UNREAD label"),
});

export const TriageRuleSchema = z.object({
  name: z.string().min(1).max(MAX_FILENAME_LENGTH).describe("Unique rule name, recorded against every message it claims"),
  when: TriageConditionsSchema.describe("Conditions; values within a field are OR'd, fields are AND'd. A rule with no conditions never matches."),
  actions: TriageActionsSchema.describe("Label changes to apply. Deleting, sending and forwarding are intentionally not expressible."),
});

export const TriagePlanSchema = z.object({
  query: queryString().optional().default("in:inbox").describe("Gmail search query selecting the messages to sort"),
  maxMessages: z.number().int().min(1).max(MAX_TRIAGE_MESSAGES).optional().default(100).describe("Maximum messages to examine in this plan (1-500)"),
  rules: z.array(TriageRuleSchema).max(MAX_TRIAGE_RULES).optional().describe("Rules to match. Omit to use the stored set from triage_set_rules."),
  shadowMode: z.boolean().optional().default(false).describe("Plan labels only — drop every archive and mark-read. Use it to try a new rule set safely."),
  includeUnmatched: z.boolean().optional().default(false).describe("List the messages no rule matched, with no action, so gaps in the rule set are visible"),
});

export const TriagePreviewSchema = z.object({
  runId: runIdString().describe("Run id returned by triage_plan"),
  maxItems: z.number().int().min(1).max(MAX_TRIAGE_MESSAGES).optional().default(50).describe("Maximum per-message rows to include (default 50)"),
  rule: z.string().min(1).max(MAX_FILENAME_LENGTH).optional().describe("Show only the messages claimed by this rule"),
});

export const TriageApplySchema = z.object({
  runId: runIdString().describe("Run id returned by triage_plan"),
  messageIds: z.array(idString()).max(MAX_TRIAGE_MESSAGES).optional().describe("Apply only these messages"),
  rules: z.array(z.string().min(1).max(MAX_FILENAME_LENGTH)).max(MAX_TRIAGE_RULES).optional().describe("Apply only the messages claimed by these rules — the way to roll out one rule at a time"),
  dryRun: z.boolean().optional().default(false).describe("Report what would be applied without calling Gmail"),
});

export const TriageRollbackSchema = z.object({
  runId: runIdString().describe("Run id to reverse. Removes the labels the run added and restores the ones it removed."),
});

export const TriageListRunsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20).describe("How many recent runs to list (default 20)"),
});

export const TriageGetRulesSchema = z.object({});

export const TriageSetRulesSchema = z.object({
  rules: z.array(TriageRuleSchema).max(MAX_TRIAGE_RULES).describe("The complete rule set; replaces whatever is stored. Pass [] to clear."),
});

// Tool definition type
export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  scopes: string[]; // Any of these scopes grants access
  annotations: ToolAnnotations;
}

// Tool registry with scope requirements
export const toolDefinitions: ToolDefinition[] = [
  // Read-only email operations
  {
    name: "read_email",
    description: "Retrieves the content of a specific email",
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Read Email", readOnlyHint: true },
  },
  {
    name: "search_emails",
    description: "Searches for emails using Gmail search syntax",
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Search Emails", readOnlyHint: true },
  },
  {
    name: "download_attachment",
    description: "Downloads an email attachment to a specified location",
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Attachment", readOnlyHint: true },
  },

  // Thread-level operations
  {
    name: "get_thread",
    description: "Retrieves all messages in an email thread in one call. Returns messages ordered chronologically (oldest first) with full content, headers, labels, and attachment metadata.",
    schema: GetThreadSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Thread", readOnlyHint: true },
  },
  {
    name: "list_inbox_threads",
    description: "Lists email threads matching a query (default: inbox). Returns thread-level view with snippet, message count, and latest message metadata.",
    schema: ListInboxThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Inbox Threads", readOnlyHint: true },
  },
  {
    name: "get_inbox_with_threads",
    description: "Convenience tool that lists threads and optionally expands each with full message content. One call returns the full inbox with complete thread bodies.",
    schema: GetInboxWithThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Inbox with Threads", readOnlyHint: true },
  },
  {
    name: "modify_thread",
    description: "Modifies labels on ALL messages in a thread atomically using the Gmail threads.modify endpoint. Use this instead of modify_email when you want to apply label changes (e.g., archive, mark as read) to an entire thread at once.",
    schema: ModifyThreadSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Thread", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "download_email",
    description: "Downloads an email to a file in various formats (json, eml, txt, html). Returns metadata only - useful for saving emails without consuming context.",
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Email", readOnlyHint: true },
  },

  // Email write operations
  {
    name: "send_email",
    description: "Sends a new email. Supports plain text, HTML, file attachments, and images embedded inline in the HTML body via inlineImages.",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Email", destructiveHint: false },
  },
  {
    name: "draft_email",
    description: "Draft a new email. Supports plain text, HTML, file attachments, and images embedded inline in the HTML body via inlineImages.",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Draft Email", destructiveHint: false },
  },
  {
    name: "send_draft",
    description: "Sends an existing draft (created via draft_email) and atomically removes it from Drafts. Prefer this over send_email when you've previously created a draft for review — avoids leaving an orphan draft in the user's Drafts folder.",
    schema: SendDraftSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Draft", destructiveHint: false },
  },
  {
    name: "delete_draft",
    description: "Deletes a draft. Use to discard an abandoned or superseded draft.",
    schema: DeleteDraftSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Delete Draft", destructiveHint: true },
  },
  {
    name: "update_draft",
    description: "Replaces the content of an existing draft. Use during iteration (\"change this and that\") instead of creating a new draft each time — avoids accumulating draft copies in the user's Drafts folder.",
    schema: UpdateDraftSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Update Draft", destructiveHint: false },
  },
  {
    name: "modify_email",
    description: "Modifies email labels (move to different folders)",
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Email", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_email",
    description: "Permanently deletes an email. Requires gmail.full because Gmail's delete endpoint is not covered by gmail.modify.",
    schema: DeleteEmailSchema,
    scopes: ["gmail.full"],
    annotations: { title: "Delete Email", destructiveHint: true },
  },
  {
    name: "batch_modify_emails",
    description: "Modifies labels for multiple emails in batches",
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Modify Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "report_phishing",
    description: "Reports a message as phishing using the closest public Gmail API behavior by applying the SPAM label",
    schema: ReportPhishingSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Report Phishing", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_report_phishing",
    description: "Reports multiple messages as phishing using the closest public Gmail API behavior by applying the SPAM label",
    schema: BatchReportPhishingSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Report Phishing", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_delete_emails",
    description: "Permanently deletes multiple emails in batches. Requires gmail.full because Gmail's batchDelete endpoint is not covered by gmail.modify.",
    schema: BatchDeleteEmailsSchema,
    scopes: ["gmail.full"],
    annotations: { title: "Batch Delete Emails", destructiveHint: true },
  },

  // Label operations
  {
    name: "list_email_labels",
    description: "Retrieves all available Gmail labels",
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
    annotations: { title: "List Email Labels", readOnlyHint: true },
  },
  {
    name: "create_label",
    description: "Creates a new Gmail label",
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Create Label", destructiveHint: false },
  },
  {
    name: "update_label",
    description: "Updates an existing Gmail label",
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Update Label", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_label",
    description: "Deletes a Gmail label",
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Delete Label", destructiveHint: true },
  },
  {
    name: "get_or_create_label",
    description: "Gets an existing label by name or creates it if it doesn't exist",
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Get or Create Label", destructiveHint: false, idempotentHint: true },
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: "Retrieves all Gmail filters",
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Filters", readOnlyHint: true },
  },
  {
    name: "get_filter",
    description: "Gets details of a specific Gmail filter",
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Get Filter", readOnlyHint: true },
  },
  {
    name: "create_filter",
    description: "Creates a new Gmail filter with custom criteria and actions",
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter", destructiveHint: false },
  },
  {
    name: "delete_filter",
    description: "Deletes a Gmail filter",
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Delete Filter", destructiveHint: true },
  },
  {
    name: "create_filter_from_template",
    description: "Creates a filter using a pre-defined template for common scenarios",
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter from Template", destructiveHint: false },
  },

  // Reply-all operation
  {
    name: "reply_all",
    description: "Replies to all recipients of an email. Automatically fetches the original email to build the recipient list (To, CC) and sets proper threading headers.",
    schema: ReplyAllSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Reply All", destructiveHint: false },
  },

  // Forward operation
  {
    name: "forward_email",
    description: "Forwards an existing email to new recipients. Fetches the original message, prepends the standard 'Forwarded message' header block, and carries attachments and inline images over by default.",
    schema: ForwardEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Forward Email", destructiveHint: false },
  },

  // Triage (rule-based mail sorting)
  //
  // Split into plan / preview / apply / rollback rather than one "sort my
  // mail" tool. Planning is read-only and produces a file listing exactly
  // which labels would move; only a separate call turns that into changes,
  // and a third reverses it.
  {
    name: "triage_plan",
    description: "Matches messages against the triage rule set and writes a plan. Reads message HEADERS only (sender, subject, List-Id, labels) — never a body. Mutates nothing; returns a run id for triage_preview / triage_apply. Unlike create_filter, this works on mail that is already in the mailbox.",
    schema: TriagePlanSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Triage: Plan", readOnlyHint: true },
  },
  {
    name: "triage_preview",
    description: "Summarizes a plan: how many messages each rule claimed, which labels they would get, and the per-message detail. Reads the local run file only.",
    schema: TriagePreviewSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Triage: Preview", readOnlyHint: true },
  },
  {
    name: "triage_apply",
    description: "Applies a plan's label changes to Gmail. Only ever adds or removes labels (archive = remove INBOX, mark read = remove UNREAD); it cannot delete, send or forward. Narrow the rollout with `rules` or `messageIds`.",
    schema: TriageApplySchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Triage: Apply", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "triage_rollback",
    description: "Reverses an applied plan — removes the labels it added and restores the ones it removed. Reverses only the plan's own changes, so edits made since are left alone.",
    schema: TriageRollbackSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Triage: Roll Back", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "triage_list_runs",
    description: "Lists recent triage runs, newest first.",
    schema: TriageListRunsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Triage: List Runs", readOnlyHint: true },
  },
  {
    name: "triage_get_rules",
    description: "Returns the stored triage rule set.",
    schema: TriageGetRulesSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Triage: Get Rules", readOnlyHint: true },
  },
  {
    name: "triage_set_rules",
    description: "Replaces the stored triage rule set. Rules match on sender, sender domain, subject, List-Id, List-Unsubscribe and existing labels — no regular expressions, no message bodies.",
    schema: TriageSetRulesSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Triage: Set Rules", destructiveHint: true, idempotentHint: true },
  },
];

// Convert tool definitions to MCP tool format
export function toMcpTools(tools: ToolDefinition[]) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema),
    annotations: tool.annotations,
  }));
}

// Get a tool definition by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolDefinitions.find(t => t.name === name);
}
