import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { cn, focusRing, Skeleton } from "@orbix/ui";
import MediaRow from "@/components/MediaRow";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { useLibraryRows } from "@/lib/queries";

/** Genre rails (all genres, biggest first) with a See-all drill-in per row. */
export default function CategoriesTab({ libraryId }: { libraryId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useLibraryRows(libraryId);
  const rows = data?.rows ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col gap-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="px-[4vw]">
            <Skeleton className="mb-3 h-6 w-40" rounded="sm" />
            <div className="flex gap-2 overflow-hidden">
              {Array.from({ length: 6 }).map((_, j) => (
                <Skeleton key={j} className="aspect-video w-[44vw] shrink-0 sm:w-[30vw] md:w-[23.5vw] lg:w-[19vw] xl:w-[15.5vw]" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="px-[4vw] text-sm text-red-400">
        {errorMessage(error instanceof ApiError ? error.code : undefined, t)}
      </p>
    );
  }

  if (rows.length === 0) {
    return <p className="px-[4vw] text-[var(--text-dim)]">{t("catalog:library.emptyCategories")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {rows.map((row) => (
        <MediaRow
          key={row.key}
          title={row.title}
          items={row.items}
          action={
            <Link
              to={`/library/${libraryId}?genre=${row.genreId}`}
              className={cn(
                "shrink-0 text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--text)]",
                focusRing,
              )}
            >
              {t("catalog:library.seeAll", { total: row.total })}
            </Link>
          }
        />
      ))}
    </div>
  );
}
