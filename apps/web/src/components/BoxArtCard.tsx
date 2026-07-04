import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import type { HomeCard } from "@/lib/types";
import { isNew, progressPct, resumeLabel } from "@/lib/spotlight";

/**
 * Netflix-style landscape box-art card for home rows. Width comes from the
 * caller. Backdrop art first, poster as a cover-crop fallback; the bottom
 * scrim always names the card since our art has no baked-in title text.
 */
export default function BoxArtCard({
  item,
  className,
}: {
  item: HomeCard;
  className?: string;
}) {
  const { t } = useTranslation();
  const matched =
    item.matchState == null || item.matchState === "matched" || item.matchState === "manual";
  const art = matched ? (item.backdropPath ?? item.posterPath) : null;
  const pct = item.progress ? progressPct(item.progress.positionSec, item.progress.durationSec) : 0;
  const sub = resumeLabel(item.resume) ?? (item.year != null ? String(item.year) : null);

  return (
    <Link
      to={`/title/${item.id}`}
      className={cn(
        "relative block shrink-0 snap-start overflow-hidden rounded-md bg-[var(--surface)]",
        "transition-transform delay-75 duration-200 hover:z-10 hover:scale-[1.06] hover:shadow-xl hover:shadow-black/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        "motion-reduce:transition-none motion-reduce:hover:transform-none",
        className,
      )}
    >
      <div className="aspect-video w-full">
        {art ? (
          <img
            src={`/api/images/${art}`}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div aria-hidden className="h-full w-full bg-gradient-to-br from-[var(--surface-2)] to-[var(--surface)]" />
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/80 via-black/55 to-transparent px-2.5 pb-2 pt-8">
        <span className="line-clamp-1 text-[13px] font-medium leading-tight text-white">
          {item.title}
        </span>
        {sub && <span className="text-[11px] leading-tight text-white/80">{sub}</span>}
      </div>

      {isNew(item.addedAt, new Date()) && (
        <span className="absolute left-1.5 top-1.5 rounded-sm bg-[var(--accent-strong)] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
          {t("catalog:spotlight.new")}
        </span>
      )}

      {pct > 0 && (
        <span data-progress className="absolute inset-x-0 bottom-0 block h-[3px] bg-white/25">
          <span className="block h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
        </span>
      )}
    </Link>
  );
}
