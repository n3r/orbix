import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type Options = {
  /** Called when Escape is pressed while the trap is active. */
  onEscape?: () => void;
  /** Element to focus first; defaults to the first focusable in the container. */
  initialFocus?: RefObject<HTMLElement | null>;
};

/**
 * Focus management for modal surfaces (dialogs, overlays, sheets).
 * While `active`, focus is moved into the container, Tab is trapped inside it,
 * Escape invokes `onEscape`, and focus is restored to the previously-focused
 * element on deactivate. Attach the returned ref to the container.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active: boolean,
  { onEscape, initialFocus }: Options = {},
): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  // Keep the latest onEscape without re-running the whole effect each render.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Fallback so the container itself can hold focus when it has no children yet.
    if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");

    const target = initialFocus?.current ?? focusables()[0] ?? container;
    const raf = requestAnimationFrame(() => target.focus());

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus only if it's still inside the trap (don't yank it away
      // from wherever the user legitimately moved on close).
      if (!previouslyFocused) return;
      if (container.contains(document.activeElement) || document.activeElement === document.body) {
        previouslyFocused.focus?.();
      }
    };
  }, [active, initialFocus]);

  return containerRef;
}
