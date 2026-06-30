export interface MenuSection {
  sectionId: string;
  name: string;
  libraryName: string;
  order: number;
}

export interface MenuEntry {
  sectionId: string;
  position: number;
}

export interface ResolvedMenuItem {
  sectionId: string;
  name: string;
  libraryName: string;
}

const view = (s: MenuSection): ResolvedMenuItem => ({
  sectionId: s.sectionId,
  name: s.name,
  libraryName: s.libraryName,
});

/**
 * Resolve the ordered catalog menu for a profile.
 *   - no entries  → every section in default order (order, then library name, then section name)
 *   - has entries → the entries' sections in `position` order, dropping any whose
 *                   section no longer exists.
 */
export function resolveProfileMenu(
  sections: MenuSection[],
  entries: MenuEntry[],
): ResolvedMenuItem[] {
  if (entries.length === 0) {
    return [...sections]
      .sort(
        (a, b) =>
          a.order - b.order ||
          a.libraryName.localeCompare(b.libraryName) ||
          a.name.localeCompare(b.name),
      )
      .map(view);
  }
  const byId = new Map(sections.map((s) => [s.sectionId, s]));
  return [...entries]
    .sort((a, b) => a.position - b.position)
    .map((e) => byId.get(e.sectionId))
    .filter((s): s is MenuSection => Boolean(s))
    .map(view);
}
