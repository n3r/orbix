import { useTranslation } from "react-i18next";
import PosterCard from "./PosterCard";
import type { MediaCard } from "@/lib/types";

interface MediaRowProps {
  title: string;
  /** Stable home-row key from the API, used to localize the heading. */
  rowKey?: string;
  items: MediaCard[];
}

// Home-row keys whose headings are static UI chrome and can be localized by
// key. Data-bearing rows (e.g. "becauseYouWatched", whose heading embeds a
// media title) are not listed and fall back to the server-provided `title`.
const LOCALIZED_ROW_KEYS = new Set(["continue", "hiddenGems", "tonight"]);

export default function MediaRow({ title, rowKey, items }: MediaRowProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  const heading =
    rowKey && LOCALIZED_ROW_KEYS.has(rowKey) ? t(`catalog:rows.${rowKey}`) : title;

  return (
    <section className="w-full px-6 md:px-8 lg:px-10 py-4">
      <h2 className="mb-3 text-xl font-semibold text-[var(--text)]">{heading}</h2>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {items.map((item) => (
          <PosterCard key={item.id} item={item} className="w-40 shrink-0" />
        ))}
      </div>
    </section>
  );
}
