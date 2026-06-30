"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, cn } from "@orbix/ui";

export interface HeroItem {
  id: string;
  title: string;
  year: number | null;
  overview: string | null;
  backdropPath: string | null;
  rating: string | null;
}

const ROTATE_MS = 7000;

export default function Hero({ items }: { items: HeroItem[] }) {
  const [index, setIndex] = useState(0);

  // Cycle through featured titles. Single item → no timer.
  useEffect(() => {
    if (items.length <= 1) return;
    const t = setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [items.length]);

  if (items.length === 0) return null;
  const active = items[index]!;

  return (
    <section className="relative h-[58vh] min-h-[360px] max-h-[620px] w-full overflow-hidden">
      {active.backdropPath && (
        <img
          key={active.id}
          src={`/api/images/${active.backdropPath}`}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {/* Legibility gradients */}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/30 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg)]/80 via-transparent to-transparent" />

      {/* Content */}
      <div className="absolute inset-x-0 bottom-0 px-6 md:px-8 lg:px-10 pb-8 md:pb-10">
        <div className="flex max-w-2xl flex-col gap-3">
          <h1 className="text-3xl font-bold text-[var(--text)] md:text-5xl">
            {active.title}
          </h1>
          <div className="flex items-center gap-3 text-sm text-[var(--text-dim)]">
            {active.year != null && <span>{active.year}</span>}
            {active.rating && (
              <span className="rounded border border-[var(--surface-2)] px-1.5 py-0.5 text-xs">
                {active.rating}
              </span>
            )}
          </div>
          {active.overview && (
            <p className="line-clamp-2 max-w-xl text-sm text-[var(--text-dim)] md:line-clamp-3">
              {active.overview}
            </p>
          )}
          <div className="mt-1 flex items-center gap-3">
            <Link href={`/title/${active.id}`}>
              <Button>▶ Play</Button>
            </Link>
            <Link href={`/title/${active.id}`}>
              <Button variant="ghost">More info</Button>
            </Link>
          </div>

          {/* Dot indicators */}
          {items.length > 1 && (
            <div className="mt-2 flex items-center gap-2">
              {items.map((it, i) => (
                <button
                  key={it.id}
                  type="button"
                  aria-label={`Show ${it.title}`}
                  onClick={() => setIndex(i)}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === index
                      ? "w-6 bg-[var(--text)]"
                      : "w-2 bg-[var(--text-dim)] hover:bg-[var(--text)]",
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
