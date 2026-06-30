import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQuery } from "@tanstack/react-query";
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
 * Netflix-style season selector + episode list for a series. Lazily loads the
 * selected season's episodes; owned episodes get a play button, the rest show as
 * unavailable. `playFirstToken` lets the hero's Play button kick off the first
 * owned episode of the current season.
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
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold text-[var(--text)]">{t("title:episodesHeading")}</h2>
        {ordered.length > 1 && (
          <select
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
            className="rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          >
            {ordered.map((s) => (
              <option key={s.seasonNumber} value={s.seasonNumber}>
                {seasonLabel(s, t)}
              </option>
            ))}
          </select>
        )}
      </div>

      <ol className="flex flex-col divide-y divide-[var(--surface-2)]">
        {episodes.map((ep) => {
          const runtime = formatRuntime(ep.runtimeSec, t);
          const pct =
            ep.progress && ep.progress.durationSec > 0 && !ep.progress.finished
              ? Math.min(100, (ep.progress.positionSec / ep.progress.durationSec) * 100)
              : ep.progress?.finished
                ? 100
                : 0;
          const playable = !!ep.fileId;

          return (
            <li key={ep.id} className="flex gap-4 py-4">
              {/* Still + play overlay */}
              <button
                type="button"
                disabled={!playable}
                onClick={() =>
                  playable &&
                  ep.fileId &&
                  onPlayEpisode({
                    fileId: ep.fileId,
                    episodeId: ep.id,
                    title: ep.title ?? t("title:episodeNumber", { number: ep.episodeNumber }),
                  })
                }
                className="group relative aspect-video w-40 shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--surface-2)] disabled:cursor-default md:w-48"
              >
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
              </button>

              {/* Meta */}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="truncate text-sm font-semibold text-[var(--text)]">
                    {ep.episodeNumber}. {ep.title ?? t("title:episodeNumber", { number: ep.episodeNumber })}
                  </h3>
                  {runtime && <span className="shrink-0 text-xs text-[var(--text-dim)]">{runtime}</span>}
                </div>
                {ep.overview && (
                  <p className="line-clamp-2 text-sm text-[var(--text-dim)]">{ep.overview}</p>
                )}
                {!playable && (
                  <span className="text-xs text-[var(--text-dim)] italic">{t("title:notInLibrary")}</span>
                )}
              </div>
            </li>
          );
        })}
        {episodes.length === 0 && (
          <li className="py-4 text-sm text-[var(--text-dim)]">{t("title:noEpisodes")}</li>
        )}
      </ol>
    </section>
  );
}
