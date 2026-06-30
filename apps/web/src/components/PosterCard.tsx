import Link from "next/link";
import { cn } from "@orbix/ui";
import type { MediaCard } from "@/lib/types";

/**
 * One poster card used by both horizontal rows and grids.
 * Width is controlled by the caller via `className`:
 *   - grids pass nothing (the grid cell sets the width)
 *   - rows pass `className="w-40 shrink-0"`
 */
export default function PosterCard({
  item,
  className,
}: {
  item: MediaCard;
  className?: string;
}) {
  const showImg =
    item.posterPath &&
    (item.matchState == null ||
      item.matchState === "matched" ||
      item.matchState === "manual");

  return (
    <Link href={`/title/${item.id}`} className={cn("group flex flex-col gap-2", className)}>
      <div className="aspect-[2/3] overflow-hidden rounded-[var(--radius)] bg-[var(--surface)] transition-transform duration-200 group-hover:scale-[1.03] group-hover:shadow-lg group-hover:shadow-black/40">
        {showImg ? (
          <img
            src={`/api/images/${item.posterPath}`}
            alt={item.title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-end p-2 text-left text-xs leading-tight text-[var(--text-dim)] line-clamp-3">
            {item.title}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="line-clamp-1 text-sm text-[var(--text)]">{item.title}</p>
        {item.year != null && (
          <p className="text-xs text-[var(--text-dim)]">{item.year}</p>
        )}
      </div>
    </Link>
  );
}
