import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import type { TvChannelCard } from "@/lib/types";
import ChannelCard from "./ChannelCard";
import { scrollBehavior } from "@/lib/motion";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/shell/icons";

/**
 * Horizontal channel rail — the home MediaRow's scroller/paddle mechanics
 * (snap strip, hidden scrollbar, gutter chevrons on row hover) with
 * ChannelCards. onPlay receives the rail's own list as the zap context.
 */
export default function ChannelRail({
  title,
  channels,
  onPlay,
}: {
  title: string;
  channels: TvChannelCard[];
  onPlay: (channel: TvChannelCard, context: TvChannelCard[]) => void;
}) {
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
  }, [update, channels.length]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: scrollBehavior() });
  };

  if (channels.length === 0) return null;

  const paddle =
    "absolute inset-y-0 z-20 flex w-[4vw] min-w-8 items-center justify-center bg-[var(--bg)]/50 text-white opacity-0 transition-opacity hover:bg-[var(--bg)]/75 focus-visible:opacity-100 focus-visible:outline-none group-hover/row:opacity-100";

  return (
    <section className="group/row w-full">
      <h2 className="mb-2 px-[4vw] text-base font-semibold text-[var(--text)] md:text-xl">{title}</h2>
      <div className="relative">
        <div
          ref={scroller}
          onScroll={update}
          className="scrollbar-none flex snap-x gap-2 overflow-x-auto scroll-smooth scroll-pl-[4vw] px-[4vw] py-2"
        >
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              onPlay={(ch) => onPlay(ch, channels)}
              className="w-[44vw] sm:w-[30vw] md:w-[23.5vw] lg:w-[19vw] xl:w-[15.5vw]"
            />
          ))}
        </div>
        {canScroll.left && (
          <button type="button" aria-label={t("catalog:rows.scrollLeft")} onClick={() => page(-1)} className={cn(paddle, "left-0")}>
            <ChevronLeftIcon className="h-8 w-8" />
          </button>
        )}
        {canScroll.right && (
          <button type="button" aria-label={t("catalog:rows.scrollRight")} onClick={() => page(1)} className={cn(paddle, "right-0")}>
            <ChevronRightIcon className="h-8 w-8" />
          </button>
        )}
      </div>
    </section>
  );
}
