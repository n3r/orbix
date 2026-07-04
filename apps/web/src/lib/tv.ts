// Pure TV display helpers (unit-tested; no fetch/DOM).

/** Up to two initials from a channel name ("Первый канал" → "ПК"). */
export function channelInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

/** Deterministic hue (0..359) from a stable channel key — monogram tiles. */
export function channelHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Localized region display name; iptv-org uses "UK" where ISO says "GB". */
export function regionName(code: string | null | undefined, locale: string): string | null {
  if (!code) return null;
  const iso = code.toUpperCase() === "UK" ? "GB" : code.toUpperCase();
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(iso) ?? code;
  } catch {
    return code; // invalid code for Intl — echo it (guide chips still render)
  }
}
