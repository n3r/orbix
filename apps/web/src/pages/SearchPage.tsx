import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { useSearch } from "@/lib/queries";
import PosterCard from "@/components/PosterCard";
import { SearchIcon } from "@/components/shell/icons";

export default function SearchPage() {
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
      ? "Please sign in to search."
      : "Search failed. Please try again."
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
            placeholder="Search — e.g. comedy under 2 hours, something funny and lighthearted"
            className="flex-1 bg-transparent text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none"
            aria-label="Search query"
          />
          {isFetching && <span className="text-xs text-[var(--text-dim)]">Searching…</span>}
        </div>
      </form>

      {errorMsg && <p className="text-sm text-red-400">{errorMsg}</p>}

      {results !== null && (
        <>
          <div className="flex items-center gap-3">
            <p className="text-sm text-[var(--text-dim)]">
              {results.length} result{results.length !== 1 ? "s" : ""}
            </p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                usedEmbeddings ? "bg-purple-900/50 text-purple-300" : "bg-[var(--surface)] text-[var(--text-dim)]"
              }`}
            >
              {usedEmbeddings ? "semantic" : "keyword"}
            </span>
          </div>

          {results.length === 0 ? (
            <p className="text-[var(--text-dim)]">No results found.</p>
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
