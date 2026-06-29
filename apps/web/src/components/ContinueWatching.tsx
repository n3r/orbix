"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

interface ContinueItem {
  mediaItemId: string;
  title: string;
  posterPath: string | null;
  positionSec: number;
  durationSec: number;
}

export default function ContinueWatching() {
  const [items, setItems] = useState<ContinueItem[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch("/continue-watching");
        if (!res.ok) return;
        const data = (await res.json()) as ContinueItem[];
        setItems(data);
      } catch {
        // Silently ignore — row just doesn't render
      }
    })();
  }, []);

  if (items.length === 0) return null;

  return (
    <section className="w-full px-8 py-4">
      <h2 className="text-xl font-semibold text-[var(--text)] mb-3">Continue Watching</h2>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {items.map((item) => (
          <Link
            key={item.mediaItemId}
            href={`/title/${item.mediaItemId}`}
            className="flex-shrink-0 w-40 flex flex-col gap-2 group"
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
          </Link>
        ))}
      </div>
    </section>
  );
}
