import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import { useSearch } from "@/lib/queries";
import PosterCard from "@/components/PosterCard";

export default function SearchPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data, isFetching, error } = useSearch(submitted);

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
    <main className="flex min-h-screen flex-col gap-6 px-6 md:px-8 lg:px-10 py-8">
      <h1 className="text-2xl font-semibold text-[var(--text)]">{t("search:title")}</h1>

      <form onSubmit={handleSubmit} className="flex gap-3 max-w-2xl">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search:placeholder")}
          className="flex-1 px-4 py-2 rounded-[var(--radius)] bg-[var(--surface)] text-[var(--text)] border border-[var(--border,transparent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          aria-label={t("search:queryAriaLabel")}
        />
        <button
          type="submit"
          disabled={isFetching}
          className="px-6 py-2 rounded-[var(--radius)] bg-[var(--accent)] text-white font-medium disabled:opacity-50"
        >
          {isFetching ? t("search:searching") : t("search:submit")}
        </button>
      </form>

      {errorMsg && <p className="text-red-400 text-sm">{errorMsg}</p>}

      {results !== null && (
        <>
          <div className="flex items-center gap-3">
            <p className="text-sm text-[var(--text-dim)]">
              {t("search:results", { count: results.length })}
            </p>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                usedEmbeddings
                  ? "bg-purple-900/50 text-purple-300"
                  : "bg-[var(--surface)] text-[var(--text-dim)]"
              }`}
            >
              {usedEmbeddings ? t("search:mode.semantic") : t("search:mode.keyword")}
            </span>
          </div>

          {results.length === 0 ? (
            <p className="text-[var(--text-dim)]">{t("search:empty")}</p>
          ) : (
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
              {results.map((item) => (
                <PosterCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
