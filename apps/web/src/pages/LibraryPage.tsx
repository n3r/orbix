import { useParams, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Tabs } from "@orbix/ui";
import BrowseTab from "@/components/library/BrowseTab";
import CategoriesTab from "@/components/library/CategoriesTab";
import GenreGridView from "@/components/library/GenreGridView";
import { useMenu } from "@/lib/queries";

/**
 * Library viewing page: Categories (auto genre rails) / Browse (flat A→Z
 * grid). URL contract: default = Categories, `?tab=browse` = Browse,
 * `?genre=<id>` = one genre's See-all grid.
 */
export default function LibraryPage() {
  const { t } = useTranslation();
  const { libraryId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: menu } = useMenu();

  if (!libraryId) return null;

  const genreParam = searchParams.get("genre");
  const genreId = genreParam && /^\d+$/.test(genreParam) ? Number(genreParam) : null;
  if (genreId != null) {
    return <GenreGridView libraryId={libraryId} genreId={genreId} />;
  }

  const tab = searchParams.get("tab") === "browse" ? "browse" : "categories";
  const libraryName = menu?.items.find((m) => m.libraryId === libraryId)?.name;

  return (
    <main className="py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 px-6 md:px-8 lg:px-10">
        <h1 className="text-3xl font-bold text-[var(--text)]">
          {libraryName ?? t("catalog:browse.title")}
        </h1>
        <Tabs
          aria-label={t("catalog:browse.title")}
          tabs={[
            { value: "categories", label: t("catalog:library.tabs.categories") },
            { value: "browse", label: t("catalog:library.tabs.browse") },
          ]}
          value={tab}
          onValueChange={(next) =>
            setSearchParams(next === "browse" ? { tab: "browse" } : {})
          }
        />
      </div>

      {tab === "categories" ? (
        <CategoriesTab libraryId={libraryId} />
      ) : (
        <BrowseTab libraryId={libraryId} />
      )}
    </main>
  );
}
