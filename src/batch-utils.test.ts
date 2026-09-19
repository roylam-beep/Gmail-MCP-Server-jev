import { describe, it, expect } from 'vitest';
import { processItemsIndividually, processBatchesWithFallback } from './batch-utils.js';

describe('processItemsIndividually', () => {
    it('reports every item as a success when all succeed', async () => {
        const seen: string[] = [];
        const { successes, failures } = await processItemsIndividually(
            ['a', 'b', 'c'],
            2,
            async (item) => { seen.push(item); },
        );

        expect(successes).toEqual(['a', 'b', 'c']);
        expect(failures).toEqual([]);
        expect(seen.sort()).toEqual(['a', 'b', 'c']);
    });

    it('does not re-run siblings of a failed item', async () => {
        // The old whole-batch retry re-issued every call in a batch after one
        // failure. For a non-idempotent op (delete) the replay hit an
        // already-deleted message and reported a false failure.
        const calls: Record<string, number> = {};
        const { successes, failures } = await processItemsIndividually(
            ['ok1', 'boom', 'ok2'],
            10,
            async (item) => {
                calls[item] = (calls[item] || 0) + 1;
                if (item === 'boom') throw new Error('not found');
            },
        );

        expect(calls).toEqual({ ok1: 1, boom: 1, ok2: 1 });
        expect(successes.sort()).toEqual(['ok1', 'ok2']);
        expect(failures).toHaveLength(1);
        expect(failures[0].item).toBe('boom');
        expect(failures[0].error.message).toBe('not found');
    });

    it('keeps going after a failure in an earlier batch', async () => {
        const { successes, failures } = await processItemsIndividually(
            ['a', 'bad', 'c', 'd'],
            2,
            async (item) => { if (item === 'bad') throw new Error('nope'); },
        );

        expect(successes).toEqual(['a', 'c', 'd']);
        expect(failures.map(f => f.item)).toEqual(['bad']);
    });

    it('wraps a non-Error rejection', async () => {
        const { failures } = await processItemsIndividually(['x'], 1, async () => {
            throw 'plain string';
        });
        expect(failures[0].error).toBeInstanceOf(Error);
        expect(failures[0].error.message).toBe('plain string');
    });

    it('honours the batch size', async () => {
        const concurrent: number[] = [];
        let inFlight = 0;

        await processItemsIndividually(
            Array.from({ length: 10 }, (_, i) => i),
            3,
            async () => {
                inFlight += 1;
                concurrent.push(inFlight);
                await new Promise(resolve => setTimeout(resolve, 1));
                inFlight -= 1;
            },
        );

        expect(Math.max(...concurrent)).toBeLessThanOrEqual(3);
    });

    it('terminates on a degenerate batch size instead of spinning forever', async () => {
        for (const batchSize of [0, -5, NaN, 0.4]) {
            const { successes } = await processItemsIndividually(
                ['a', 'b'],
                batchSize,
                async () => {},
            );
            expect(successes).toEqual(['a', 'b']);
        }
    });

    it('handles an empty item list', async () => {
        const { successes, failures } = await processItemsIndividually([], 50, async () => {});
        expect(successes).toEqual([]);
        expect(failures).toEqual([]);
    });
});

describe('processBatchesWithFallback', () => {
    it('sends whole chunks while they succeed', async () => {
        const chunks: string[][] = [];
        const { successes, failures } = await processBatchesWithFallback(
            ['a', 'b', 'c'],
            2,
            async (batch) => { chunks.push([...batch]); },
        );

        expect(chunks).toEqual([['a', 'b'], ['c']]);
        expect(successes).toEqual(['a', 'b', 'c']);
        expect(failures).toEqual([]);
    });

    it('falls back to one call per item when a chunk fails', async () => {
        const { successes, failures } = await processBatchesWithFallback(
            ['a', 'bad', 'c'],
            3,
            async (batch) => {
                if (batch.length > 1 || batch[0] === 'bad') {
                    throw new Error('batch rejected');
                }
            },
        );

        expect(successes).toEqual(['a', 'c']);
        expect(failures.map(f => f.item)).toEqual(['bad']);
    });

    it('terminates on a degenerate batch size', async () => {
        const { successes } = await processBatchesWithFallback(['a', 'b'], 0, async () => {});
        expect(successes).toEqual(['a', 'b']);
    });
});
