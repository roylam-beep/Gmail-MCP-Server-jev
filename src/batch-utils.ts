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
        // Calling processItem inside the wrapper keeps a SYNCHRONOUS throw from
        // escaping before allSettled runs, which would reject the whole call
        // and discard every success already recorded.
        const settled = await Promise.allSettled(
            batch.map(async item => processItem(item)),
        );

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

/**
 * Map over `items` with at most `limit` operations in flight.
 *
 * Read paths used to fan out with a bare Promise.all: search_emails issued one
 * messages.get per hit (up to 500) and get_inbox_with_threads one threads.get
 * per thread, all at once. Gmail answers that burst with 429
 * rateLimitExceeded, so the larger the request the more likely it fails
 * outright. A bounded window keeps results in input order and the request rate
 * inside Gmail's per-user quota.
 */
export async function mapWithConcurrency<T, U>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
    const results = new Array<U>(items.length);
    const width = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    let next = 0;
    // Promise.all rejects on the first failure but never signals the other
    // workers, so they used to drain the whole list in the background after the
    // handler had already returned the error. On a 429 that meant the remaining
    // ~495 requests of a 500-hit page still went out — the opposite of what
    // bounding the fan-out is for.
    let failed = false;

    const worker = async (): Promise<void> => {
        while (!failed) {
            const index = next++;
            if (index >= items.length) return;
            try {
                results[index] = await mapper(items[index], index);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(width, items.length) }, () => worker()),
    );

    return results;
}
