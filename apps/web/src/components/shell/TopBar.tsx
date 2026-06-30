"use client";

import { cn } from "@orbix/ui";

/** Slim top bar shown only on mobile — hosts the drawer hamburger. */
export default function TopBar({
  onMenu,
  className,
}: {
  onMenu: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-14 items-center gap-3 border-b border-[var(--surface-2)] px-4",
        className,
      )}
    >
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open navigation"
        className="text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
      >
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      <span className="text-lg font-bold text-[var(--text)]">Orbix</span>
    </div>
  );
}
