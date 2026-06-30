import { useState } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Input } from "@orbix/ui";
import PosterCard from "@/components/PosterCard";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { useLibraryItems } from "@/lib/queries";

export default function LibraryPage() {
  const { t } = useTranslation();
  const { libraryId } = useParams();
  const [sort, setSort] = useState("title");
  const [q, setQ] = useState("");
  const { data: items = [], isLoading, error } = useLibraryItems(libraryId, sort, q);

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
      <h1 className="mb-6 text-3xl font-bold text-[var(--text)]">{t("catalog:browse.title")}</h1>

      {/* Controls */}
      <div className="mb-6 flex flex-wrap gap-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("catalog:browse.searchPlaceholder")}
          className="max-w-xs"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
        >
          <option value="title">{t("catalog:browse.sort.title")}</option>
          <option value="added">{t("catalog:browse.sort.added")}</option>
          <option value="year">{t("catalog:browse.sort.year")}</option>
        </select>
      </div>

      {error && (
        <p className="mb-4 text-sm text-red-400">
          {errorMessage(error instanceof ApiError ? error.code : undefined, t)}
        </p>
      )}
      {isLoading && <p className="text-[var(--text-dim)]">{t("common:status.loading")}</p>}
      {!isLoading && items.length === 0 && (
        <p className="text-[var(--text-dim)]">{t("catalog:browse.empty")}</p>
      )}

      {/* Poster grid — fills the full content width on wide screens */}
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {items.map((item) => (
          <PosterCard key={item.id} item={item} />
        ))}
      </div>
    </main>
  );
}
