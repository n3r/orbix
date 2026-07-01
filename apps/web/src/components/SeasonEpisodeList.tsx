import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@orbix/ui";
import { apiJson } from "@/lib/api";
import type { SeasonSummary, EpisodeCard } from "@/lib/types";

export interface PlayEpisode {
  fileId: string;
  episodeId: string;
  title: string;
}

function formatRuntime(seconds: number | null, t: TFunction): string | null {
  if (seconds == null || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h === 0 ? t("title:runtime.m", { m }) : t("title:runtime.hm", { h, m });
}

function seasonLabel(s: SeasonSummary, t: TFunction): string {
  if (s.seasonNumber === 0) return s.name ?? t("title:specials");
  return s.name && !/^season\s/i.test(s.name)
    ? s.name
    : t("title:seasonNumber", { number: s.seasonNumber });
}

/**
 * Netflix-style season tabs + episode grid for a series. Lazily loads the
 * selected season's episodes; each episode is a card with its still on top and
 * "# Title" below. Owned episodes are playable; the rest show as unavailable.
 * `playFirstToken` lets the hero's Play button kick off the first owned episode
 * of the current season.
 */
export default function SeasonEpisodeList({
  seriesId,
  seasons,
  onPlayEpisode,
  playFirstToken,
}: {
  seriesId: string;
  seasons: SeasonSummary[];
  onPlayEpisode: (ep: PlayEpisode) => void;
  playFirstToken: number;
}) {
  const { t } = useTranslation();
  const ordered = [...seasons].sort((a, b) => a.seasonNumber - b.seasonNumber);
  // Default to the first non-specials season when available.
  const initial = ordered.find((s) => s.seasonNumber > 0) ?? ordered[0];
  const [selected, setSelected] = useState<number>(initial?.seasonNumber ?? 1);

  const { data } = useQuery({
    queryKey: ["episodes", seriesId, selected],
    queryFn: () =>
      apiJson<{ episodes: EpisodeCard[] }>(`/items/${seriesId}/seasons/${selected}/episodes`),
    retry: false,
  });
  const episodes = useMemo(() => data?.episodes ?? [], [data]);

  // Hero "Play": play the first owned episode of the loaded season.
  const handledToken = useRef(0);
  useEffect(() => {
    if (playFirstToken <= 0 || playFirstToken === handledToken.current) return;
    const first = episodes.find((e) => e.fileId);
    if (first?.fileId) {
      handledToken.current = playFirstToken;
      onPlayEpisode({
        fileId: first.fileId,
        episodeId: first.id,
        title: first.title ?? t("title:episodeNumber", { number: first.episodeNumber }),
      });
    }
  }, [playFirstToken, episodes, onPlayEpisode, t]);

  if (ordered.length === 0) return null;

  return (
    <section className="flex w-full flex-col gap-4 px-6 py-6 md:px-12 lg:px-16">
      <h2 className="text-xl font-semibold text-[var(--text)]">{t("title:episodesHeading")}</h2>

      {/* Season tabs */}
      <div role="tablist" aria-label={t("title:episodesHeading")} className="flex flex-wrap gap-1 border-b border-[var(--surface-2)]">
        {ordered.map((s) => {
          const active = s.seasonNumber === selected;
          return (
            <button
              key={s.seasonNumber}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelected(s.seasonNumber)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2 text-sm transition-colors",
                active
                  ? "border-[var(--accent)] font-medium text-[var(--text)]"
                  : "border-transparent text-[var(--text-dim)] hover:text-[var(--text)]",
              )}
            >
              {seasonLabel(s, t)}
            </button>
          );
        })}
      </div>

      {/* Episode grid: still on top, "# Title" below */}
      {episodes.length === 0 ? (
        <p className="py-4 text-sm text-[var(--text-dim)]">{t("title:noEpisodes")}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {episodes.map((ep) => {
            const runtime = formatRuntime(ep.runtimeSec, t);
            const pct =
              ep.progress && ep.progress.durationSec > 0 && !ep.progress.finished
                ? Math.min(100, (ep.progress.positionSec / ep.progress.durationSec) * 100)
                : ep.progress?.finished
                  ? 100
                  : 0;
            const playable = !!ep.fileId;
            const title = ep.title ?? t("title:episodeNumber", { number: ep.episodeNumber });

            return (
              <li key={ep.id}>
                <button
                  type="button"
                  disabled={!playable}
                  onClick={() =>
                    playable &&
                    ep.fileId &&
                    onPlayEpisode({ fileId: ep.fileId, episodeId: ep.id, title })
                  }
                  className="group flex w-full flex-col gap-2 text-left disabled:cursor-default"
                >
                  {/* Still + play overlay */}
                  <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-sm)] bg-[var(--surface-2)]">
                    {ep.stillPath ? (
                      <img
                        src={`/api/images/${ep.stillPath}`}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-2xl text-[var(--text-dim)]">
                        {ep.episodeNumber}
                      </div>
                    )}
                    {playable && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-3xl text-white opacity-0 transition-opacity group-hover:opacity-100">
                        ▶
                      </span>
                    )}
                    {pct > 0 && (
                      <span className="absolute bottom-0 left-0 h-1 bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                    )}
                  </div>

                  {/* # Title */}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="truncate text-sm font-medium text-[var(--text)]">
                        {ep.episodeNumber}. {title}
                      </h3>
                      {runtime && <span className="shrink-0 text-xs text-[var(--text-dim)]">{runtime}</span>}
                    </div>
                    {!playable && (
                      <span className="text-xs italic text-[var(--text-dim)]">{t("title:notInLibrary")}</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
