export function rememberBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
