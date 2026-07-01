import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HomeCard } from "@/lib/types";
import { itemDetailOptions, useItemDetail } from "@/lib/queries";
import SpotlightHero from "./SpotlightHero";
import SpotlightPoster from "./SpotlightPoster";

/**
 * Featured home row: a large hover-promotable hero on the left and a
 * horizontally-scrollable poster strip on the right (stacked on mobile).
 * Hovering/focusing a poster promotes it to the hero after `debounceMs`.
 */
export default function SpotlightRow({
  items,
  debounceMs = 200,
}: {
  items: HomeCard[];
  debounceMs?: number;
}) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qc = useQueryClient();

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const promote = (id: string) => {
    clear();
    timer.current = setTimeout(() => setActiveId(id), debounceMs);
  };
  useEffect(() => clear, []);

  // Prefetch the first few items' details so the initial and next promotions
  // paint instantly instead of flashing the skeleton on first hover.
  useEffect(() => {
    for (const it of items.slice(0, 3)) qc.prefetchQuery(itemDetailOptions(it.id));
  }, [items, qc]);

  const active = items.find((i) => i.id === activeId) ?? items[0];
  const detail = useItemDetail(active?.id);
  if (!active) return null;

  return (
    <section className="w-full px-6 py-4 md:px-8 lg:px-10">
      <div className="flex flex-col gap-4 md:flex-row md:items-stretch">
        <div className="md:w-[62%] lg:w-[66%]">
          <SpotlightHero card={active} detail={detail.data} />
        </div>
        <div className="flex gap-3 overflow-x-auto pb-2 md:flex-1" onMouseLeave={clear}>
          {items.map((item) => (
            <SpotlightPoster
              key={item.id}
              item={item}
              active={item.id === active.id}
              onPromote={() => promote(item.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
