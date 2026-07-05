import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@orbix/ui";
import PosterGrid from "./PosterGrid";
import { useLibraryItems } from "@/lib/queries";

/** Flat A→Z/А→Я poster grid over the whole library, with title search. */
export default function BrowseTab({ libraryId }: { libraryId: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const { data: items = [], isLoading, error } = useLibraryItems(libraryId, "alpha", q);

  return (
    <div className="px-6 md:px-8 lg:px-10">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("catalog:browse.searchPlaceholder")}
        className="mb-6 max-w-xs"
      />
      <PosterGrid items={items} isLoading={isLoading} error={error} />
    </div>
  );
}
