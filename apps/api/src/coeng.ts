/**
 * Item-item co-engagement ("people who liked X also liked Y"): cosine over the
 * sets of users with a positive reward, shrunk toward 0 for low support.
 */
export function buildCoeng(
  positives: { user_id: string; pageid: number }[],
  { minSupport = 5, topK = 20, shrink = 10, perUser = 100 } = {},
): Record<string, [number, number][]> {
  const byUser = new Map<string, number[]>();
  for (const { user_id, pageid } of positives) {
    const list = byUser.get(user_id) ?? [];
    if (!list.includes(pageid)) list.push(pageid);
    byUser.set(user_id, list);
  }
  const count = new Map<number, number>();
  const pairs = new Map<string, number>();
  for (const list of byUser.values()) {
    const items = list.slice(-perUser);
    for (const a of items) count.set(a, (count.get(a) ?? 0) + 1);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const [a, b] = items[i] < items[j] ? [items[i], items[j]] : [items[j], items[i]];
        const k = `${a}:${b}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
  }
  const out = new Map<number, [number, number][]>();
  for (const [k, co] of pairs) {
    if (co < minSupport) continue;
    const [a, b] = k.split(":").map(Number);
    const score = (co / Math.sqrt(count.get(a)! * count.get(b)!)) * (co / (co + shrink));
    for (const [x, y] of [[a, b], [b, a]]) {
      const list = out.get(x) ?? [];
      list.push([y, Math.round(Math.min(1, score) * 1000) / 1000]);
      out.set(x, list);
    }
  }
  return Object.fromEntries(
    [...out].map(([k, list]) => [String(k), list.sort((p, q) => q[1] - p[1]).slice(0, topK)]),
  );
}
