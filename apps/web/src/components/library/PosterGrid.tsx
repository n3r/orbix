import { useTranslation } from "react-i18next";
import { Skeleton } from "@orbix/ui";
import PosterCard from "@/components/PosterCard";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import type { MediaCard } from "@/lib/types";

/** Poster grid with loading skeletons, error and empty states (Browse + genre See-all). */
export default function PosterGrid({
  items,
  isLoading,
  error,
}: {
  items: MediaCard[];
  isLoading: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  return (
    <>
      {error != null && (
        <p className="mb-4 text-sm text-red-400">
          {errorMessage(error instanceof ApiError ? error.code : undefined, t)}
        </p>
      )}
      {!isLoading && error == null && items.length === 0 && (
        <p className="text-[var(--text-dim)]">{t("catalog:browse.empty")}</p>
      )}
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {isLoading
          ? Array.from({ length: 21 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="aspect-[2/3] w-full" />
                <Skeleton className="h-4 w-3/4" rounded="sm" />
              </div>
            ))
          : items.map((item) => <PosterCard key={item.id} item={item} />)}
      </div>
    </>
  );
}
