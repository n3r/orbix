"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

interface MediaItem {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  matchState: string;
}

interface Props {
  params: Promise<{ sectionId: string }>;
}

export default function LibraryPage({ params }: Props) {
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState("title");
  const [q, setQ] = useState("");

  useEffect(() => {
    params.then((p) => setSectionId(p.sectionId));
  }, [params]);

  const loadItems = useCallback(async () => {
    if (!sectionId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ sort });
      if (q) qs.set("q", q);
      const res = await apiFetch(`/sections/${sectionId}/items?${qs}`);
      if (!res.ok) {
        setError("Failed to load items");
        return;
      }
      const data = (await res.json()) as MediaItem[];
      setItems(data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [sectionId, sort, q]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold text-[var(--text)] mb-6">Browse</h1>

      {/* Controls */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles…"
          className="max-w-xs"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="bg-[var(--surface)] text-[var(--text)] rounded-[var(--radius-sm)] px-3 py-2 border border-[var(--border,#333)]"
        >
          <option value="title">Title (A–Z)</option>
          <option value="added">Recently Added</option>
          <option value="year">Year</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      {loading && <p className="text-[var(--text-dim)]">Loading…</p>}

      {!loading && items.length === 0 && (
        <p className="text-[var(--text-dim)]">No items found.</p>
      )}

      {/* Poster Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {items.map((item) => (
          <Link key={item.id} href={`/title/${item.id}`} className="group">
            <div className="flex flex-col gap-2">
              <div className="aspect-[2/3] bg-[var(--surface)] rounded-[var(--radius)] overflow-hidden relative">
                {item.matchState === "matched" && item.posterPath ? (
                  <img
                    src={`/api/images/${item.posterPath}`}
                    alt={item.title}
                    className="w-full h-full object-cover group-hover:opacity-80 transition-opacity"
                  />
                ) : (
                  <div className="w-full h-full flex items-end p-2">
                    <span className="text-xs text-[var(--text-dim)] line-clamp-3 leading-tight">
                      {item.title}
                    </span>
                  </div>
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text)] line-clamp-1">
                  {item.title}
                </p>
                {item.year && (
                  <p className="text-xs text-[var(--text-dim)]">{item.year}</p>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
