"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

interface Candidate {
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string;
}

interface Props {
  params: Promise<{ id: string }>;
}

export default function FixMatchPage({ params }: Props) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(null);
  const [itemTitle, setItemTitle] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [matchingId, setMatchingId] = useState<number | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [posterPath, setPosterPath] = useState<string | null>(null);
  const [settingPoster, setSettingPoster] = useState<string | null>(null);
  const [posterError, setPosterError] = useState<string | null>(null);

  // Resolve the dynamic route param
  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  // Fetch item title to pre-fill the search box
  useEffect(() => {
    if (!id) return;
    void (async () => {
      const res = await apiFetch(`/items/${id}`);
      if (res.ok) {
        const data = (await res.json()) as { title: string };
        setItemTitle(data.title);
        setQuery(data.title);
      }
    })();
  }, [id]);

  // Auto-search once the item title has been fetched and pre-filled.
  // handleSearch reads `query` and `id` from the closure; both are set
  // synchronously from the item fetch above, so this fires only on initial load.
  useEffect(() => {
    if (!itemTitle) return;
    void handleSearch();
  }, [itemTitle]); // intentional: trigger only when title is first resolved

  async function handleSearch() {
    if (!id) return;
    setSearching(true);
    setSearchError(null);
    setCandidates([]);
    try {
      const res = await apiFetch(`/items/${id}/match-candidates?q=${encodeURIComponent(query)}`);
      if (res.status === 503) {
        setSearchError("TMDB token not configured. Go to Settings to add your API token.");
        return;
      }
      if (!res.ok) {
        setSearchError("Search failed. Please try again.");
        return;
      }
      const data = (await res.json()) as Candidate[];
      setCandidates(data);
      if (data.length === 0) setSearchError("No results found.");
    } catch {
      setSearchError("Network error.");
    } finally {
      setSearching(false);
    }
  }

  async function handleMatch(tmdbId: number) {
    if (!id) return;
    setMatchingId(tmdbId);
    setMatchError(null);
    try {
      const res = await apiFetch(`/items/${id}/match`, {
        method: "POST",
        body: JSON.stringify({ tmdbId }),
      });
      if (res.status === 503) {
        setMatchError("TMDB token not configured.");
        return;
      }
      if (!res.ok) {
        setMatchError("Failed to apply match.");
        return;
      }
      router.push(`/title/${id}`);
    } catch {
      setMatchError("Network error.");
    } finally {
      setMatchingId(null);
    }
  }

  async function handleSetPoster(tmdbPosterPath: string) {
    if (!id) return;
    setSettingPoster(tmdbPosterPath);
    setPosterError(null);
    try {
      const res = await apiFetch(`/items/${id}/poster`, {
        method: "POST",
        body: JSON.stringify({ tmdbPosterPath }),
      });
      if (res.status === 503) {
        setPosterError("TMDB token not configured.");
        return;
      }
      if (!res.ok) {
        setPosterError("Failed to set poster.");
        return;
      }
      setPosterPath(tmdbPosterPath);
    } catch {
      setPosterError("Network error.");
    } finally {
      setSettingPoster(null);
    }
  }

  return (
    <main className="p-8 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={() => id && router.push(`/title/${id}`)}>
          &larr; Back
        </Button>
        <h1 className="text-2xl font-bold text-[var(--text)]">Fix Match</h1>
        {itemTitle && (
          <span className="text-[var(--text-dim)] text-sm">for &ldquo;{itemTitle}&rdquo;</span>
        )}
      </div>

      {/* Search section */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-[var(--text)]">Search TMDB</h2>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            placeholder="Search title…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
          />
          <Button onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
            {searching ? "Searching…" : "Search"}
          </Button>
        </div>

        {searchError && <p className="text-sm text-red-400">{searchError}</p>}
        {matchError && <p className="text-sm text-red-400">{matchError}</p>}

        {/* Candidate list */}
        {candidates.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {candidates.map((c) => (
              <div
                key={c.tmdbId}
                className="bg-[var(--surface)] rounded-[var(--radius)] p-3 flex flex-col gap-2"
              >
                {c.posterPath ? (
                  <img
                    src={`https://image.tmdb.org/t/p/w200${c.posterPath}`}
                    alt={c.title}
                    className="w-full rounded-[var(--radius-sm)] object-cover aspect-[2/3]"
                  />
                ) : (
                  <div className="w-full rounded-[var(--radius-sm)] bg-[var(--surface-2)] aspect-[2/3] flex items-center justify-center text-[var(--text-dim)] text-xs">
                    No poster
                  </div>
                )}
                <p className="text-sm font-medium text-[var(--text)] leading-snug">{c.title}</p>
                {c.year && <p className="text-xs text-[var(--text-dim)]">{c.year}</p>}
                <Button
                  className="w-full text-sm py-1"
                  onClick={() => void handleMatch(c.tmdbId)}
                  disabled={matchingId !== null}
                >
                  {matchingId === c.tmdbId ? "Applying…" : "Use this match"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Poster picker */}
      {candidates.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-[var(--text)]">Set a specific poster</h2>
          <p className="text-sm text-[var(--text-dim)]">
            Pick any poster from the search results above without changing other metadata.
          </p>

          {posterError && <p className="text-sm text-red-400">{posterError}</p>}
          {posterPath && (
            <p className="text-sm text-green-400">Poster updated successfully.</p>
          )}

          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-3">
            {candidates
              .filter((c) => c.posterPath)
              .map((c) => (
                <div key={c.tmdbId} className="flex flex-col gap-1">
                  <img
                    src={`https://image.tmdb.org/t/p/w200${c.posterPath!}`}
                    alt={c.title}
                    className="w-full rounded-[var(--radius-sm)] object-cover aspect-[2/3] cursor-pointer hover:ring-2 hover:ring-[var(--accent)]"
                    onClick={() => void handleSetPoster(c.posterPath!)}
                  />
                  <Button
                    className="w-full text-xs py-0.5"
                    variant="ghost"
                    onClick={() => void handleSetPoster(c.posterPath!)}
                    disabled={settingPoster !== null}
                  >
                    {settingPoster === c.posterPath ? "Setting…" : "Set poster"}
                  </Button>
                </div>
              ))}
          </div>
        </section>
      )}
    </main>
  );
}
