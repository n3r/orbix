import { cn } from "@orbix/ui";
import type { Ratings } from "@/lib/types";

function fmt1(n: number): string {
  return n.toFixed(1);
}

/**
 * Rating chips for the title hero. Every value is optional — the component
 * renders only what is present and returns null when nothing is available, so
 * it degrades cleanly before the ratings-ingestion phase populates the data.
 */
export default function RatingBadges({
  imdbRating,
  rtRating,
  tmdbScore,
  metacritic,
  mpaa,
  className,
}: Ratings & { mpaa?: string | null; className?: string }) {
  const hasAny =
    imdbRating != null ||
    rtRating != null ||
    tmdbScore != null ||
    metacritic != null ||
    (mpaa != null && mpaa.length > 0);
  if (!hasAny) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-sm", className)}>
      {imdbRating != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[#f5c518] px-1.5 py-0.5 font-semibold text-black">
          <span className="text-[11px] font-bold tracking-tight">IMDb</span>
          <span>{fmt1(imdbRating)}</span>
        </span>
      )}
      {rtRating != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--text)]">
          <span aria-hidden>{rtRating >= 60 ? "🍅" : "🤢"}</span>
          <span>{rtRating}%</span>
        </span>
      )}
      {tmdbScore != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--text)]">
          <span className="text-[11px] font-semibold text-[var(--accent)]">TMDB</span>
          <span>{fmt1(tmdbScore)}</span>
        </span>
      )}
      {metacritic != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--text)]">
          <span className="text-[11px] font-semibold">MC</span>
          <span>{metacritic}</span>
        </span>
      )}
      {mpaa != null && mpaa.length > 0 && (
        <span className="rounded-[var(--radius-sm)] border border-[var(--text-dim)]/40 px-1.5 py-0.5 text-xs text-[var(--text-dim)]">
          {mpaa}
        </span>
      )}
    </div>
  );
}
