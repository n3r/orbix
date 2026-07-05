import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn, focusRing } from "@orbix/ui";
import BoxArtCard from "./BoxArtCard";
import { scrollBehavior } from "@/lib/motion";
import type { HomeCard } from "@/lib/types";
import { ChevronLeftIcon, ChevronRightIcon } from "./shell/icons";

interface MediaRowProps {
  title: string;
  /** Stable home-row key from the API, used to localize the heading. */
  rowKey?: string;
  items: HomeCard[];
}

// Home-row keys whose headings are static UI chrome and can be localized by
// key. Data-bearing rows (e.g. "becauseYouWatched", whose heading embeds a
// media title) are not listed and fall back to the server-provided `title`.
const LOCALIZED_ROW_KEYS = new Set(["continue", "hiddenGems", "tonight"]);

/**
 * Netflix-style row: tight strip of landscape cards, hidden scrollbar, and
 * gutter-width chevron paddles that page the strip and appear on row hover.
 */
export default function MediaRow({ title, rowKey, items }: MediaRowProps) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [update, items.length]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: scrollBehavior() });
  };

  if (items.length === 0) return null;

  const heading =
    rowKey && LOCALIZED_ROW_KEYS.has(rowKey) ? t(`catalog:rows.${rowKey}`) : title;

  const paddle =
    "absolute inset-y-0 z-20 flex w-[4vw] min-w-8 items-center justify-center bg-[var(--bg)]/50 text-white opacity-0 transition-opacity hover:bg-[var(--bg)]/75 focus-visible:opacity-100 focus-visible:outline-none group-hover/row:opacity-100";

  return (
    <section className="group/row w-full">
      <h2 className="mb-2 px-[4vw] text-base font-semibold text-[var(--text)] md:text-xl">
        {heading}
      </h2>
      <div className="relative">
        <div
          ref={scroller}
          onScroll={update}
          data-testid="row-scroller"
          className="scrollbar-none flex snap-x gap-2 overflow-x-auto scroll-smooth scroll-pl-[4vw] px-[4vw] py-2"
        >
          {items.map((item) => (
            <BoxArtCard
              key={item.id}
              item={item}
              className="w-[44vw] sm:w-[30vw] md:w-[23.5vw] lg:w-[19vw] xl:w-[15.5vw]"
            />
          ))}
        </div>
        {canScroll.left && (
          <button type="button" aria-label={t("catalog:rows.scrollLeft")} onClick={() => page(-1)} className={cn(paddle, "left-0", focusRing)}>
            <ChevronLeftIcon className="h-8 w-8" />
          </button>
        )}
        {canScroll.right && (
          <button type="button" aria-label={t("catalog:rows.scrollRight")} onClick={() => page(1)} className={cn(paddle, "right-0", focusRing)}>
            <ChevronRightIcon className="h-8 w-8" />
          </button>
        )}
      </div>
    </section>
  );
}
