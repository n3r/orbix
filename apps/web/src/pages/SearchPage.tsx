import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton, cn } from "@orbix/ui";
import { ApiError } from "@/lib/api";
import { useSearch } from "@/lib/queries";
import PosterCard from "@/components/PosterCard";
import { SearchIcon } from "@/components/shell/icons";

/** Poster-shaped placeholders matching the results grid, shown while searching. */
function SearchSkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
      {Array.from({ length: 14 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="aspect-[2/3] w-full" />
          <Skeleton className="h-4 w-3/4" rounded="sm" />
        </div>
      ))}
    </div>
  );
}

export default function SearchPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isFetching, error } = useSearch(submitted);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSubmitted(query.trim());
  }

  const errorMsg = error
    ? error instanceof ApiError && error.status === 401
      ? t("errors:unauthenticated")
      : t("search:errors.failed")
    : null;
  const results = data?.items ?? null;
  const usedEmbeddings = data?.usedEmbeddings ?? false;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 md:px-8 py-6">
      <form onSubmit={handleSubmit} className="sticky top-14 z-10 -mx-4 bg-[var(--bg,transparent)] px-4 py-2">
        <div className="flex items-center gap-3 rounded-full border border-[var(--surface-2)] bg-[var(--surface)] px-4 py-3 focus-within:ring-2 focus-within:ring-[var(--accent)]">
          <SearchIcon className="h-5 w-5 text-[var(--text-dim)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search:placeholder")}
            className="flex-1 bg-transparent text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none"
            aria-label={t("search:queryAriaLabel")}
          />
          {isFetching && <span className="text-xs text-[var(--text-dim)]">{t("search:searching")}</span>}
        </div>
      </form>

      {errorMsg && <p className="text-sm text-red-400">{errorMsg}</p>}

      {/* Teaching landing state: before the first query is submitted. */}
      {!submitted && !errorMsg && (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <h2 className="text-xl font-semibold text-[var(--text)]">{t("search:landing")}</h2>
          <p className="max-w-md text-sm text-[var(--text-dim)]">{t("search:placeholder")}</p>
        </div>
      )}

      {/* First search in flight (no previous results to keep): skeleton grid. */}
      {submitted && results === null && isFetching && !errorMsg && <SearchSkeletonGrid />}

      {results !== null && (
        // Keep prior results visible but dimmed while a re-query is in flight
        // (placeholderData keeps them) so re-searches don't flash empty.
        <div className={cn(isFetching && "opacity-50 transition-opacity")}>
          <div className="mb-6 flex items-center gap-3">
            <p className="text-sm text-[var(--text-dim)]">
              {t("search:results", { count: results.length })}
            </p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                usedEmbeddings ? "bg-purple-900/50 text-purple-300" : "bg-[var(--surface)] text-[var(--text-dim)]"
              }`}
            >
              {usedEmbeddings ? t("search:mode.semantic") : t("search:mode.keyword")}
            </span>
          </div>

          {results.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-[var(--text)]">{t("search:empty")}</p>
              <p className="text-sm text-[var(--text-dim)]">{t("search:emptyHint")}</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
              {results.map((item) => (
                <PosterCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
