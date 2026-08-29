/** Run `worker` over `items` with bounded concurrency, preserving input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

/** Split an array into fixed-size batches. */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
