/**
 * Assign stable channel numbers. Channels already numbered (present in
 * `existing`, keyed by extId) keep their numbers — numbers are never reused or
 * auto-renumbered. New channels append after `existingMax` (the max number
 * across ALL sources), ordered country-then-name (plain code-point comparison
 * for determinism across ICU builds; null country sorts last).
 */
export function assignNumbers(
  existingMax: number,
  existing: Map<string, number>,
  incoming: { extId: string; country: string | null; name: string }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const fresh: { extId: string; country: string | null; name: string }[] = [];

  for (const c of incoming) {
    const current = existing.get(c.extId);
    if (current != null) out.set(c.extId, current);
    else fresh.push(c);
  }

  fresh.sort((a, b) => {
    const ca = a.country ?? "￿"; // null country after every real code
    const cb = b.country ?? "￿";
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.extId < b.extId ? -1 : a.extId > b.extId ? 1 : 0;
  });

  let next = existingMax;
  for (const c of fresh) {
    next += 1;
    out.set(c.extId, next);
  }
  return out;
}
