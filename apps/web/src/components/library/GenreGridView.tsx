import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { cn, focusRing } from "@orbix/ui";
import PosterGrid from "./PosterGrid";
import { useLibraryItems, useLibraryRows } from "@/lib/queries";

/** "See all" drill-in for one genre: full grid, rail order (top-rated first). */
export default function GenreGridView({ libraryId, genreId }: { libraryId: string; genreId: number }) {
  const { t } = useTranslation();
  // Row metadata (localized heading) comes from the rows query — already
  // cached when arriving via a rail, fetched fresh on a deep link.
  const { data: rowsData } = useLibraryRows(libraryId);
  const row = rowsData?.rows.find((r) => r.genreId === genreId);
  const { data: items = [], isLoading, error } = useLibraryItems(libraryId, "rating", "", genreId);

  return (
    <main className="px-6 py-8 md:px-8 lg:px-10">
      <Link
        to={`/library/${libraryId}`}
        className={cn(
          "mb-4 inline-block text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--text)]",
          focusRing,
        )}
      >
        ← {t("catalog:library.back")}
      </Link>
      <h1 className="mb-6 text-3xl font-bold text-[var(--text)]">{row?.title ?? ""}</h1>
      <PosterGrid items={items} isLoading={isLoading} error={error} />
    </main>
  );
}
