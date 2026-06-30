export interface MenuLibrary {
  libraryId: string;
  name: string;
  order: number;
}

export interface MenuEntry {
  libraryId: string;
  position: number;
}

export interface ResolvedMenuItem {
  libraryId: string;
  name: string;
}

const view = (l: MenuLibrary): ResolvedMenuItem => ({
  libraryId: l.libraryId,
  name: l.name,
});

/**
 * Resolve the ordered catalog menu for a profile.
 *   - no entries  → every library in default order (order, then name)
 *   - has entries → the entries' libraries in `position` order, dropping any whose
 *                   library no longer exists.
 */
export function resolveProfileMenu(
  libraries: MenuLibrary[],
  entries: MenuEntry[],
): ResolvedMenuItem[] {
  if (entries.length === 0) {
    return [...libraries]
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map(view);
  }
  const byId = new Map(libraries.map((l) => [l.libraryId, l]));
  return [...entries]
    .sort((a, b) => a.position - b.position)
    .map((e) => byId.get(e.libraryId))
    .filter((l): l is MenuLibrary => Boolean(l))
    .map(view);
}
