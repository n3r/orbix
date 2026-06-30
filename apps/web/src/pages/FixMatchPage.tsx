import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

interface Candidate {
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string;
}

export default function FixMatchPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
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
        setSearchError(t("errors:tmdb_not_configured"));
        return;
      }
      if (!res.ok) {
        setSearchError(t("fix:search.failed"));
        return;
      }
      const data = (await res.json()) as Candidate[];
      setCandidates(data);
      if (data.length === 0) setSearchError(t("fix:search.noResults"));
    } catch {
      setSearchError(t("errors:network"));
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
        setMatchError(t("errors:tmdb_not_configured"));
        return;
      }
      if (!res.ok) {
        setMatchError(t("fix:match.failed"));
        return;
      }
      navigate(`/title/${id}`);
    } catch {
      setMatchError(t("errors:network"));
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
        setPosterError(t("errors:tmdb_not_configured"));
        return;
      }
      if (!res.ok) {
        setPosterError(t("fix:poster.failed"));
        return;
      }
      setPosterPath(tmdbPosterPath);
    } catch {
      setPosterError(t("errors:network"));
    } finally {
      setSettingPoster(null);
    }
  }

  return (
    <main className="p-8 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={() => id && navigate(`/title/${id}`)}>
          &larr; {t("common:actions.back")}
        </Button>
        <h1 className="text-2xl font-bold text-[var(--text)]">{t("fix:title")}</h1>
        {itemTitle && (
          <span className="text-[var(--text-dim)] text-sm">{t("fix:forTitle", { title: itemTitle })}</span>
        )}
      </div>

      {/* Search section */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-[var(--text)]">{t("fix:search.heading")}</h2>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            placeholder={t("fix:search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
          />
          <Button onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
            {searching ? t("fix:search.searching") : t("fix:search.button")}
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
                    {t("fix:noPoster")}
                  </div>
                )}
                <p className="text-sm font-medium text-[var(--text)] leading-snug">{c.title}</p>
                {c.year && <p className="text-xs text-[var(--text-dim)]">{c.year}</p>}
                <Button
                  className="w-full text-sm py-1"
                  onClick={() => void handleMatch(c.tmdbId)}
                  disabled={matchingId !== null}
                >
                  {matchingId === c.tmdbId ? t("fix:match.applying") : t("fix:match.button")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Poster picker */}
      {candidates.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-[var(--text)]">{t("fix:poster.heading")}</h2>
          <p className="text-sm text-[var(--text-dim)]">
            {t("fix:poster.help")}
          </p>

          {posterError && <p className="text-sm text-red-400">{posterError}</p>}
          {posterPath && (
            <p className="text-sm text-green-400">{t("fix:poster.success")}</p>
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
                    {settingPoster === c.posterPath ? t("fix:poster.setting") : t("fix:poster.button")}
                  </Button>
                </div>
              ))}
          </div>
        </section>
      )}
    </main>
  );
}
