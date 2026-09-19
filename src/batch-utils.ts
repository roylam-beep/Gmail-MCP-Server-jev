/**
 * Result of running an operation over a list of items.
 */
export interface BatchResult<T> {
    successes: T[];
    failures: { item: T; error: Error }[];
}

function toError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Run `processItem` over every item, `batchSize` at a time, settling each item
 * independently.
 *
 * The previous shape ran a whole batch under Promise.all and, when the batch
 * rejected, replayed every item in it one by one. Promise.all rejects on the
 * first failure while its siblings are already in flight, so the replay
 * re-issued operations that had in fact succeeded. For batch_delete_emails
 * that meant deleting a message, then deleting it again — the second call
 * returns 404 and the message was reported as a failure despite being gone.
 *
 * Settling per item reports exactly what happened and never repeats work.
 */
export async function processItemsIndividually<T>(
    items: T[],
    batchSize: number,
    processItem: (item: T) => Promise<unknown>,
): Promise<BatchResult<T>> {
    const successes: T[] = [];
    const failures: { item: T; error: Error }[] = [];
    // Defence in depth: the schema bounds batchSize to 1..100, but a zero step
    // here would spin this loop forever.
    const step = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1;

    for (let i = 0; i < items.length; i += step) {
        const batch = items.slice(i, i + step);
        const settled = await Promise.allSettled(batch.map(item => processItem(item)));

        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                successes.push(batch[index]);
            } else {
                failures.push({ item: batch[index], error: toError(result.reason) });
            }
        });
    }

    return { successes, failures };
}

/**
 * Run `processBatch` over chunks of `batchSize` items, falling back to one
 * call per item when a chunk fails.
 *
 * Only for genuinely batch-shaped endpoints (Gmail's messages.batchModify),
 * where a chunk failure says nothing about individual items. The fallback
 * re-issues the operation per item, so the operation must be idempotent.
 * For per-item endpoints use processItemsIndividually() instead.
 */
export async function processBatchesWithFallback<T>(
    items: T[],
    batchSize: number,
    processBatch: (batch: T[]) => Promise<unknown>,
): Promise<BatchResult<T>> {
    const successes: T[] = [];
    const failures: { item: T; error: Error }[] = [];
    const step = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1;

    for (let i = 0; i < items.length; i += step) {
        const batch = items.slice(i, i + step);
        try {
            await processBatch(batch);
            successes.push(...batch);
        } catch {
            for (const item of batch) {
                try {
                    await processBatch([item]);
                    successes.push(item);
                } catch (itemError) {
                    failures.push({ item, error: toError(itemError) });
                }
            }
        }
    }

    return { successes, failures };
}
