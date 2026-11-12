const COLD_LIST_ATTEMPTS = 10;
const COLD_LIST_RETRY_MS = 300;

/**
 * Load a list, retrying while it is empty. Since OpenCode 2.2.7, a cold
 * location answers list reads before its plugins finish loading.
 */
export async function coldList<T>(
  load: () => Promise<T[]>,
  attempts = COLD_LIST_ATTEMPTS,
): Promise<T[]> {
  let items: T[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0)
      await new Promise((resolve) => setTimeout(resolve, COLD_LIST_RETRY_MS));
    items = await load();
    if (items.length > 0) break;
  }
  return items;
}
