"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Button } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

const Player = dynamic(() => import("@/components/Player"), { ssr: false });

interface CastMember {
  name: string;
  character: string;
}

interface MediaFile {
  id: string;
  path: string;
  container: string | null;
  videoCodec: string | null;
  audioCodecs: string[];
  width: number | null;
  height: number | null;
  durationSec: number | null;
  size: string | null;
}

interface ItemDetail {
  id: string;
  title: string;
  year: number | null;
  overview: string | null;
  runtimeSec: number | null;
  rating: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  matchState: string;
  genres: string[];
  cast: CastMember[];
  director: { name: string } | null;
  files: MediaFile[];
}

interface Props {
  params: Promise<{ id: string }>;
}

function formatRuntime(seconds: number | null): string | null {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export default function TitlePage({ params }: Props) {
  const [id, setId] = useState<string | null>(null);
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/items/${id}`);
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) {
          setError("Failed to load title");
          return;
        }
        const data = (await res.json()) as ItemDetail;
        setItem(data);
      } catch {
        setError("Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading) {
    return (
      <main className="p-8">
        <p className="text-[var(--text-dim)]">Loading…</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-bold text-[var(--text)]">Title not found</h1>
      </main>
    );
  }

  if (error || !item) {
    return (
      <main className="p-8">
        <p className="text-sm text-red-400">{error ?? "Unknown error"}</p>
      </main>
    );
  }

  const runtime = formatRuntime(item.runtimeSec);

  return (
    <main className="flex flex-col min-h-screen">
      {/* Backdrop */}
      {item.backdropPath && (
        <div className="relative w-full h-64 md:h-96 overflow-hidden">
          <img
            src={`/api/images/${item.backdropPath}`}
            alt=""
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
        </div>
      )}

      <div className="p-8 max-w-4xl mx-auto w-full flex flex-col gap-6">
        {/* Header */}
        <div className="flex gap-6 flex-wrap">
          {item.posterPath && (
            <img
              src={`/api/images/${item.posterPath}`}
              alt={item.title}
              className="w-32 rounded-[var(--radius)] flex-shrink-0 hidden md:block"
            />
          )}
          <div className="flex flex-col gap-3">
            <h1 className="text-4xl font-bold text-[var(--text)]">{item.title}</h1>
            <div className="flex gap-3 flex-wrap text-[var(--text-dim)] text-sm">
              {item.year && <span>{item.year}</span>}
              {runtime && <span>{runtime}</span>}
              {item.rating && <span>{item.rating}</span>}
            </div>

            {/* Unmatched notice */}
            {item.matchState !== "matched" && item.matchState !== "manual" && (
              <p className="text-sm text-yellow-400">
                Metadata not matched yet — scan with a TMDB token to enrich.
              </p>
            )}

            {/* Admin: Fix match action */}
            {id && (
              <div className="mt-1">
                <Link
                  href={`/title/${id}/fix`}
                  className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)] underline underline-offset-2"
                >
                  Fix match / poster (admin)
                </Link>
              </div>
            )}

            {/* Genres */}
            {item.genres.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {item.genres.map((g) => (
                  <span
                    key={g}
                    className="text-xs bg-[var(--surface)] px-2 py-1 rounded-full text-[var(--text-dim)]"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {/* Play button */}
            <div className="mt-2">
              {item.files?.[0]?.id ? (
                <Button onClick={() => setPlaying(true)}>Play</Button>
              ) : (
                <Button disabled>Play (no media)</Button>
              )}
            </div>
          </div>
        </div>

        {/* Player */}
        {playing && item.files?.[0]?.id && (
          <Player
            fileId={item.files[0].id}
            mediaItemId={item.id}
            title={item.title}
          />
        )}

        {/* Overview */}
        {item.overview && (
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)] mb-2">Overview</h2>
            <p className="text-[var(--text-dim)] leading-relaxed">{item.overview}</p>
          </div>
        )}

        {/* Director */}
        {item.director && (
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)] mb-2">Director</h2>
            <p className="text-[var(--text-dim)]">{item.director.name}</p>
          </div>
        )}

        {/* Cast */}
        {item.cast.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)] mb-3">Cast</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {item.cast.map((c, i) => (
                <div key={i} className="bg-[var(--surface)] rounded-[var(--radius)] p-3">
                  <p className="text-sm font-medium text-[var(--text)]">{c.name}</p>
                  {c.character && (
                    <p className="text-xs text-[var(--text-dim)]">{c.character}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
