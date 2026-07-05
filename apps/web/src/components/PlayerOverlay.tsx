import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { cn, focusRing, useFocusTrap } from "@orbix/ui";
import Player from "./Player";

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

interface Props {
  fileId: string;
  mediaItemId: string;
  title: string;
  /** Set for TV episodes so progress is keyed per-episode (movies omit it). */
  episodeId?: string;
  onClose: () => void;
}

/**
 * Full-page cinema container for the player. Mounts as a fixed overlay portaled
 * to <body> (above the app shell, no URL change), locks body scroll, and closes
 * on the top-left chevron or `Esc`.
 */
export default function PlayerOverlay({ fileId, mediaItemId, title, episodeId, onClose }: Props) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Trap focus inside the cinema overlay and restore it to the trigger on close.
  // Escape is handled by the dedicated effect below (it respects fullscreen), so
  // the trap only manages focus, not Escape.
  const containerRef = useFocusTrap<HTMLDivElement>(true, { initialFocus: closeRef });

  // Lock background scroll while the overlay is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Esc closes the overlay — unless the browser is in native fullscreen, in
  // which case the first Esc should exit fullscreen (let the browser handle it).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.fullscreenElement) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[var(--z-overlay)] bg-black"
    >
      <Player fileId={fileId} mediaItemId={mediaItemId} title={title} episodeId={episodeId} />

      {/* Back / close affordance — always visible, top-left, above the player. */}
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label={t("player:close")}
        className={cn(
          "absolute left-3 top-3 z-10 grid h-11 w-11 place-items-center rounded-full",
          "bg-black/40 text-white/90 transition-colors hover:bg-black/70 hover:text-white",
          focusRing,
        )}
      >
        <ChevronDownIcon className="h-6 w-6" />
      </button>
    </div>,
    document.body,
  );
}
