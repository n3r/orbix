/**
 * Scroll behavior that honours `prefers-reduced-motion`. Programmatic
 * `scrollBy`/`scrollTo` with `behavior: "smooth"` overrides the CSS reduced-motion
 * reset, so JS-driven scrolls must opt out of animation explicitly.
 */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || !window.matchMedia) return "smooth";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
