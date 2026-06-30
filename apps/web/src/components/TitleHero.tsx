import { Button } from "@orbix/ui";
import RatingBadges from "@/components/RatingBadges";
import type { TitleDetail } from "@/lib/types";

function formatRuntime(seconds: number | null): string | null {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

/**
 * Full-bleed cinematic hero for a title detail page. Shows the official logo
 * art when available (Phase 2 populates logoPath) and otherwise large title
 * type, layered over the backdrop with bottom + left scrims for legibility.
 */
export default function TitleHero({
  item,
  onPlay,
  canPlay,
  playLabel,
}: {
  item: TitleDetail;
  onPlay: () => void;
  canPlay: boolean;
  playLabel: string;
}) {
  const runtime = formatRuntime(item.runtimeSec);
  const seasonCount = item.seasons?.length;
  const episodeCount = item.seasons?.reduce((n, s) => n + s.episodeCount, 0);

  return (
    <section className="relative flex min-h-[60vh] w-full items-end overflow-hidden md:min-h-[78vh]">
      {/* Backdrop */}
      {item.backdropPath ? (
        <img
          src={`/api/images/${item.backdropPath}`}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--surface-2)] to-[var(--bg)]" />
      )}
      {/* Cinematic scrims */}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg)]/85 via-[var(--bg)]/25 to-transparent" />

      {/* Content */}
      <div className="relative z-10 flex w-full max-w-5xl flex-col gap-4 px-6 pb-10 md:px-12 md:pb-16 lg:px-16">
        {item.logoPath ? (
          <img
            src={`/api/images/${item.logoPath}`}
            alt={item.title}
            className="max-h-28 max-w-[70%] object-contain object-left drop-shadow-2xl md:max-h-44"
          />
        ) : (
          <h1 className="text-4xl font-extrabold tracking-tight text-[var(--text)] drop-shadow-2xl md:text-6xl">
            {item.title}
          </h1>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--text-dim)]">
          <RatingBadges
            imdbRating={item.imdbRating}
            rtRating={item.rtRating}
            tmdbScore={item.tmdbScore}
            metacritic={item.metacritic}
            mpaa={item.rating}
          />
          {item.year != null && <span>{item.year}</span>}
          {item.kind === "series" && seasonCount ? (
            <span>
              {seasonCount} season{seasonCount > 1 ? "s" : ""}
              {episodeCount ? ` · ${episodeCount} episodes` : ""}
            </span>
          ) : (
            runtime && <span>{runtime}</span>
          )}
          {item.genres.slice(0, 3).map((g) => (
            <span key={g}>· {g}</span>
          ))}
        </div>

        {item.overview && (
          <p className="max-w-2xl leading-relaxed text-[var(--text)]/90 line-clamp-3 drop-shadow">
            {item.overview}
          </p>
        )}

        <div className="mt-2 flex items-center gap-3">
          <Button onClick={onPlay} disabled={!canPlay}>
            {canPlay ? (
              <>
                <span aria-hidden="true">▶</span> {playLabel}
              </>
            ) : (
              "No media"
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}
