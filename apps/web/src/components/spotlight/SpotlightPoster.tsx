import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import type { HomeCard } from "@/lib/types";
import { isNew, progressPct } from "@/lib/spotlight";

/**
 * One trailing poster in the spotlight strip. Hovering or focusing promotes it
 * (via `onPromote`); clicking navigates to the title. Shows a continue-watching
 * progress bar and a "NEW" badge when applicable.
 */
export default function SpotlightPoster({
  item,
  active,
  onPromote,
}: {
  item: HomeCard;
  active: boolean;
  onPromote: () => void;
}) {
  const { t } = useTranslation();
  const showImg =
    item.posterPath &&
    (item.matchState == null || item.matchState === "matched" || item.matchState === "manual");
  const pct = item.progress ? progressPct(item.progress.positionSec, item.progress.durationSec) : 0;

  return (
    <Link
      to={`/title/${item.id}`}
      onMouseEnter={onPromote}
      onFocus={onPromote}
      className={cn(
        "group relative w-28 shrink-0 overflow-hidden rounded-[var(--radius)] outline-none md:w-32",
        active && "ring-2 ring-[var(--accent)]",
      )}
    >
      <div className="aspect-[2/3] bg-[var(--surface)]">
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
      {isNew(item.addedAt, new Date()) && (
        <span className="absolute left-1 top-1 rounded bg-[var(--accent)] px-1 py-0.5 text-[10px] font-semibold text-white">
          {t("catalog:spotlight.new")}
        </span>
      )}
      {pct > 0 && (
        <span
          data-progress
          className="absolute bottom-0 left-0 h-1 bg-[var(--accent)]"
          style={{ width: `${pct}%` }}
        />
      )}
    </Link>
  );
}
