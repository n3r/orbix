"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

interface SearchItem {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  matchState: string;
}

interface SearchResponse {
  items: SearchItem[];
  usedEmbeddings: boolean;
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[] | null>(null);
  const [usedEmbeddings, setUsedEmbeddings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`/search?q=${encodeURIComponent(query.trim())}`);
      if (res.status === 401) {
        setError("Please sign in to search.");
        return;
      }
      if (!res.ok) {
        setError("Search failed. Please try again.");
        return;
      }
      const data = (await res.json()) as SearchResponse;
      setResults(data.items ?? []);
      setUsedEmbeddings(data.usedEmbeddings ?? false);
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col gap-6 px-8 py-8">
      <div className="flex items-center gap-6">
        <Link
          href="/"
          className="text-sm text-[var(--text-dim)] hover:text-[var(--text)] transition-colors"
        >
          ← Home
        </Link>
        <h1 className="text-2xl font-semibold text-[var(--text)]">Search</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-3 max-w-2xl">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. comedy under 2 hours, something funny and lighthearted"
          className="flex-1 px-4 py-2 rounded-[var(--radius)] bg-[var(--surface)] text-[var(--text)] border border-[var(--border,transparent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          aria-label="Search query"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-6 py-2 rounded-[var(--radius)] bg-[var(--accent)] text-white font-medium disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {results !== null && (
        <>
          <div className="flex items-center gap-3">
            <p className="text-sm text-[var(--text-dim)]">
              {results.length} result{results.length !== 1 ? "s" : ""}
            </p>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                usedEmbeddings
                  ? "bg-purple-900/50 text-purple-300"
                  : "bg-[var(--surface)] text-[var(--text-dim)]"
              }`}
            >
              {usedEmbeddings ? "semantic" : "keyword"}
            </span>
          </div>

          {results.length === 0 ? (
            <p className="text-[var(--text-dim)]">No results found.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {results.map((item) => (
                <Link
                  key={item.id}
                  href={`/title/${item.id}`}
                  className="flex flex-col gap-2 group"
                >
                  {item.posterPath ? (
                    <img
                      src={`/api/images/${item.posterPath}`}
                      alt={item.title}
                      className="w-full aspect-[2/3] object-cover rounded-[var(--radius)] group-hover:opacity-80 transition-opacity"
                    />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-[var(--surface)] rounded-[var(--radius)] flex items-center justify-center">
                      <span className="text-[var(--text-dim)] text-xs">No image</span>
                    </div>
                  )}
                  <p className="text-sm text-[var(--text)] truncate">{item.title}</p>
                  {item.year !== null && (
                    <p className="text-xs text-[var(--text-dim)] -mt-1">{item.year}</p>
                  )}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
