import { useState } from "react";
import { useParams } from "react-router";
import { Input } from "@orbix/ui";
import PosterCard from "@/components/PosterCard";
import { useLibraryItems } from "@/lib/queries";

export default function LibraryPage() {
  const { libraryId } = useParams();
  const [sort, setSort] = useState("title");
  const [q, setQ] = useState("");
  const { data: items = [], isLoading, error } = useLibraryItems(libraryId, sort, q);

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
      <h1 className="mb-6 text-3xl font-bold text-[var(--text)]">Browse</h1>

      {/* Controls */}
      <div className="mb-6 flex flex-wrap gap-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles…"
          className="max-w-xs"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
        >
          <option value="title">Title (A–Z)</option>
          <option value="added">Recently Added</option>
          <option value="year">Year</option>
        </select>
      </div>

      {error && <p className="mb-4 text-sm text-red-400">Failed to load items</p>}
      {isLoading && <p className="text-[var(--text-dim)]">Loading…</p>}
      {!isLoading && items.length === 0 && (
        <p className="text-[var(--text-dim)]">No items found.</p>
      )}

      {/* Poster grid — fills the full content width on wide screens */}
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {items.map((item) => (
          <PosterCard key={item.id} item={item} />
        ))}
      </div>
    </main>
  );
}
