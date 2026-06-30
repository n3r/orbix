import { useState, lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { apiJson, ApiError } from "@/lib/api";
import type { TitleDetail } from "@/lib/types";
import TitleHero from "@/components/TitleHero";
import SimilarRail from "@/components/SimilarRail";
import SeasonEpisodeList, { type PlayEpisode } from "@/components/SeasonEpisodeList";

const PlayerOverlay = lazy(() => import("@/components/PlayerOverlay"));

interface PlayTarget {
  fileId: string;
  episodeId?: string;
  title: string;
}

export default function TitlePage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  // Bumped by the hero Play button so the episode list plays the first episode.
  const [heroPlayToken, setHeroPlayToken] = useState(0);

  const itemQuery = useQuery({
    queryKey: ["item", id],
    enabled: !!id,
    queryFn: () => apiJson<TitleDetail>(`/items/${id}`),
    retry: false,
  });

  const onPlayEpisode = useCallback((ep: PlayEpisode) => {
    setPlayTarget({ fileId: ep.fileId, episodeId: ep.episodeId, title: ep.title });
  }, []);

  const notFound = itemQuery.error instanceof ApiError && itemQuery.error.status === 404;

  if (itemQuery.isLoading) {
    return (
      <main className="p-8">
        <p className="text-[var(--text-dim)]">{t("common:status.loading")}</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-bold text-[var(--text)]">{t("title:notFound")}</h1>
      </main>
    );
  }

  const item = itemQuery.data;
  if (!item) {
    return (
      <main className="p-8">
        <p className="text-sm text-red-400">{t("title:loadFailed")}</p>
      </main>
    );
  }

  const isSeries = item.kind === "series";
  const firstFileId = item.files?.[0]?.id ?? null;
  const canPlay = isSeries ? (item.seasons?.length ?? 0) > 0 : !!firstFileId;

  const handleHeroPlay = () => {
    if (isSeries) {
      setHeroPlayToken((n) => n + 1);
    } else if (firstFileId) {
      setPlayTarget({ fileId: firstFileId, episodeId: undefined, title: item.title });
    }
  };

  return (
    <main className="flex w-full flex-col">
      <TitleHero item={item} canPlay={canPlay} playLabel={t("title:play")} onPlay={handleHeroPlay} />

      {/* Full-page player overlay (portaled to <body>) */}
      {playTarget && id && (
        <Suspense fallback={null}>
          <PlayerOverlay
            key={playTarget.episodeId ?? playTarget.fileId}
            fileId={playTarget.fileId}
            mediaItemId={id}
            episodeId={playTarget.episodeId}
            title={playTarget.title}
            onClose={() => setPlayTarget(null)}
          />
        </Suspense>
      )}

      {/* Seasons & Episodes (series only) */}
      {isSeries && id && item.seasons && item.seasons.length > 0 && (
        <SeasonEpisodeList
          seriesId={id}
          seasons={item.seasons}
          onPlayEpisode={onPlayEpisode}
          playFirstToken={heroPlayToken}
        />
      )}

      <div className="flex w-full flex-col gap-10 px-6 py-8 md:px-12 lg:px-16">
        {/* Unmatched notice */}
        {item.matchState !== "matched" && item.matchState !== "manual" && (
          <p className="text-sm text-yellow-400">{t("title:unmatchedNotice")}</p>
        )}

        {/* Cast */}
        {item.cast.length > 0 && (
          <section>
            <h2 className="mb-3 text-xl font-semibold text-[var(--text)]">{t("title:section.cast")}</h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {item.cast.map((c, i) => (
                <div key={i} className="w-32 shrink-0 rounded-[var(--radius)] bg-[var(--surface)] p-3">
                  <p className="line-clamp-1 text-sm font-medium text-[var(--text)]">{c.name}</p>
                  {c.character && (
                    <p className="line-clamp-1 text-xs text-[var(--text-dim)]">{c.character}</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* More Like This (full-bleed rail) */}
      {id && <SimilarRail itemId={id} />}

      {/* Details */}
      <div className="flex w-full flex-col gap-4 px-6 py-8 md:px-12 lg:px-16">
        {item.director && (
          <p className="text-sm text-[var(--text-dim)]">
            <span className="text-[var(--text)]">{t("title:section.director")}:</span> {item.director.name}
          </p>
        )}
        {item.genres.length > 0 && (
          <p className="text-sm text-[var(--text-dim)]">
            <span className="text-[var(--text)]">{t("title:section.genres")}:</span> {item.genres.join(", ")}
          </p>
        )}
      </div>
    </main>
  );
}
