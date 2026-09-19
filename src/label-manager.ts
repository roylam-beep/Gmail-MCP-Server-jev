/**
 * Label Manager for Gmail MCP Server
 * Provides comprehensive label management functionality
 */

// Type definitions for Gmail API labels
export interface GmailLabel {
    id: string;
    name: string;
    type?: string;
    messageListVisibility?: string;
    labelListVisibility?: string;
    messagesTotal?: number;
    messagesUnread?: number;
    color?: {
        textColor?: string;
        backgroundColor?: string;
    };
}

/**
 * Turn a Gmail API failure into something the caller can act on.
 *
 * Every catch here collapsed to `Failed to X: ${error.message}`, which drops
 * the status and with it the only actionable part: a 403 means re-authenticate
 * with a wider scope, a 429 or 503 means retry. getOrCreateLabel stacked three
 * of those prefixes onto one sentence.
 */
function describeLabelError(operation: string, error: any): Error {
    // Already one of ours — do not wrap it again.
    if (error instanceof Error && !(error as any).code && !(error as any).status) {
        return error;
    }

    const status = error?.status ?? error?.code;
    if (status === 403) {
        return new Error(
            `Cannot ${operation}: this account is not authorized for label changes. ` +
            `Re-run \`auth --scopes=gmail.modify,gmail.labels\`.`,
        );
    }
    if (status === 429 || status === 503) {
        return new Error(`Cannot ${operation}: Gmail is throttling or unavailable (HTTP ${status}) — retry shortly.`);
    }
    return new Error(`Failed to ${operation}${status ? ` (HTTP ${status})` : ''}: ${error?.message ?? error}`);
}

/**
 * Creates a new Gmail label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The newly created label
 */
export async function createLabel(gmail: any, labelName: string, options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
} = {}) {
    try {
        // Default visibility settings if not provided
        const messageListVisibility = options.messageListVisibility || 'show';
        const labelListVisibility = options.labelListVisibility || 'labelShow';

        const response = await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
                name: labelName,
                messageListVisibility,
                labelListVisibility,
            },
        });

        return response.data;
    } catch (error: any) {
        // Gmail answers a duplicate with HTTP 409 and the text "Label name
        // exists or conflicts" — never "already exists", so this branch was
        // dead and the user saw the raw API string instead. The status code
        // was on the same object all along.
        if (error.code === 409 || error.status === 409) {
            throw new Error(
                `Label "${labelName}" already exists, or collides with a reserved Gmail name. ` +
                `Use get_or_create_label, or pick a different name.`,
            );
        }

        throw describeLabelError('create label', error);
    }
}

/**
 * Updates an existing Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to update
 * @param updates - Properties to update
 * @returns The updated label
 */
export async function updateLabel(gmail: any, labelId: string, updates: {
    name?: string;
    messageListVisibility?: string;
    labelListVisibility?: string;
}) {
    try {
        // deleteLabel already refuses system labels using exactly this lookup;
        // updateLabel did the same get and then didn't check, so renaming SENT
        // came back as Gmail's "Invalid label name: SENT" — which reads like
        // the name was malformed rather than the label being untouchable.
        const current = await gmail.users.labels.get({ userId: 'me', id: labelId });
        if (current.data?.type === 'system') {
            throw new Error(`"${current.data.name}" is a Gmail system label and cannot be renamed or reconfigured.`);
        }
        if (Object.keys(updates).length === 0) {
            throw new Error(
                `No changes given for label "${current.data?.name ?? labelId}" — ` +
                `pass name, messageListVisibility or labelListVisibility.`,
            );
        }

        const response = await gmail.users.labels.update({
            userId: 'me',
            id: labelId,
            requestBody: updates,
        });

        return response.data;
    } catch (error: any) {
        if (error.code === 404) {
            throw new Error(`Label with ID "${labelId}" not found.`);
        }
        
        throw describeLabelError('update label', error);
    }
}

/**
 * Deletes a Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to delete
 * @returns Success message
 */
export async function deleteLabel(gmail: any, labelId: string) {
    try {
        // Ensure we're not trying to delete system labels
        const label = await gmail.users.labels.get({
            userId: 'me',
            id: labelId,
        });
        
        if (label.data.type === 'system') {
            throw new Error(`Cannot delete system label with ID "${labelId}".`);
        }
        
        await gmail.users.labels.delete({
            userId: 'me',
            id: labelId,
        });

        return { success: true, message: `Label "${label.data.name}" deleted successfully.` };
    } catch (error: any) {
        if (error.code === 404) {
            throw new Error(`Label with ID "${labelId}" not found.`);
        }
        
        throw describeLabelError('delete label', error);
    }
}

/**
 * Gets a detailed list of all Gmail labels
 * @param gmail - Gmail API instance
 * @returns Object containing system and user labels
 */
export async function listLabels(gmail: any) {
    try {
        const response = await gmail.users.labels.list({
            userId: 'me',
        });

        const labels = response.data.labels || [];
        
        // Group labels by type for better organization
        const systemLabels = labels.filter((label:GmailLabel) => label.type === 'system');
        const userLabels = labels.filter((label:GmailLabel) => label.type === 'user');

        return {
            all: labels,
            system: systemLabels,
            user: userLabels,
            count: {
                total: labels.length,
                system: systemLabels.length,
                user: userLabels.length
            }
        };
    } catch (error: any) {
        throw describeLabelError('list labels', error);
    }
}

/**
 * Finds a label by name
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to find
 * @returns The found label or null if not found
 */
export async function findLabelByName(gmail: any, labelName: string) {
    try {
        const labelsResponse = await listLabels(gmail);
        const allLabels = labelsResponse.all;
        
        // Case-insensitive match
        const foundLabel = allLabels.find(
            (label: GmailLabel) => label.name.toLowerCase() === labelName.toLowerCase()
        );
        
        return foundLabel || null;
    } catch (error: any) {
        throw describeLabelError('find label', error);
    }
}

/**
 * Creates label if it doesn't exist or returns existing label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The new or existing label
 */
export async function getOrCreateLabel(gmail: any, labelName: string, options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
} = {}) {
    try {
        // First try to find an existing label
        const existingLabel = await findLabelByName(gmail, labelName);

        if (existingLabel) {
            // The caller exposes messageListVisibility / labelListVisibility on
            // this tool but they only ever applied on the create path, so a hit
            // reported success while silently ignoring them. Say so instead.
            const drift = (['messageListVisibility', 'labelListVisibility'] as const)
                .filter(key => options[key] && options[key] !== (existingLabel as any)[key]);
            if (drift.length > 0) {
                throw new Error(
                    `Label "${existingLabel.name}" already exists with different ${drift.join(' and ')}. ` +
                    `Use update_label (id ${existingLabel.id}) to change it.`,
                );
            }
            // Whether the label was created is a fact this function knows and
            // the caller was reduced to guessing from the label's shape — and
            // guessing it backwards.
            return { ...existingLabel, created: false };
        }

        // If not found, create a new one
        const created = await createLabel(gmail, labelName, options);
        return { ...created, created: true };
    } catch (error: any) {
        throw describeLabelError('get or create label', error);
    }
}
