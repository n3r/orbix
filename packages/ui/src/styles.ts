/**
 * Shared focus-visible ring. One definition, applied to every interactive
 * control so keyboard focus is consistent and always visible on the dark UI.
 *
 * - `focusRing`: standard, with an offset ring — for controls on solid surfaces
 *   (buttons, inputs, nav links).
 * - `focusRingInset`: inset ring, no offset — for cards / rows layered over
 *   artwork or inside scrollers, where an offset ring would clip or clash.
 */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]";

export const focusRingInset =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-inset";
