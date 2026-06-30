/** Swap the item at `index` one slot toward `dir` (-1 up, 1 down). No-op at the ends. */
export function moveItem<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list.slice();
  const next = list.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
