import { useTranslation } from "react-i18next";
import PosterCard from "@/components/PosterCard";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { useWishlist } from "@/lib/queries";

export default function WishlistPage() {
  const { t } = useTranslation();
  const { data: items = [], isLoading, error } = useWishlist();

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
      <h1 className="mb-6 text-3xl font-bold text-[var(--text)]">{t("wishlist:heading")}</h1>

      {error && (
        <p className="mb-4 text-sm text-red-400">
          {errorMessage(error instanceof ApiError ? error.code : undefined, t)}
        </p>
      )}
      {isLoading && <p className="text-[var(--text-dim)]">{t("common:status.loading")}</p>}
      {!isLoading && !error && items.length === 0 && (
        <div className="text-[var(--text-dim)]">
          <p>{t("wishlist:empty")}</p>
          <p className="mt-1 text-sm">{t("wishlist:emptyHint")}</p>
        </div>
      )}

      {/* Poster grid — same responsive columns as the library browse page */}
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {items.map((item) => (
          <PosterCard key={item.id} item={item} />
        ))}
      </div>
    </main>
  );
}
