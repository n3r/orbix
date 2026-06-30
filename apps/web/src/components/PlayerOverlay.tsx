import { useEffect } from "react";
import { createPortal } from "react-dom";
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
    <div className="fixed inset-0 z-50 bg-black">
      <Player fileId={fileId} mediaItemId={mediaItemId} title={title} episodeId={episodeId} />

      {/* Back / close affordance — always visible, top-left, above the player. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close player"
        className="absolute left-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/70 hover:text-white"
      >
        <ChevronDownIcon className="h-6 w-6" />
      </button>
    </div>,
    document.body,
  );
}
