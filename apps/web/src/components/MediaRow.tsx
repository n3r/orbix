import PosterCard from "./PosterCard";
import type { MediaCard } from "@/lib/types";

interface MediaRowProps {
  title: string;
  items: MediaCard[];
}

export default function MediaRow({ title, items }: MediaRowProps) {
  if (items.length === 0) return null;

  return (
    <section className="w-full px-6 md:px-8 lg:px-10 py-4">
      <h2 className="mb-3 text-xl font-semibold text-[var(--text)]">{title}</h2>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {items.map((item) => (
          <PosterCard key={item.id} item={item} className="w-40 shrink-0" />
        ))}
      </div>
    </section>
  );
}
