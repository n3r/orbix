import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@orbix/ui";
import { useTvGrid } from "@/lib/queries";
import type { TvGridChannel } from "@/lib/types";
import { formatTvTime } from "@/lib/tv-time";
import {
  floorToHour,
  shiftHours,
  primeTimeOnDay,
  computeBlockRect,
  generateTimeTicks,
  nowLinePercent,
} from "@/lib/tv-grid-layout";
import { ChannelLogo } from "./ChannelLogo";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/shell/icons";

// ── Bounded time window (NOT an infinite day scroll — see brief). ─────────
const HOURS = 4;
const WINDOW_MS = HOURS * 3_600_000;
const TICK_STEP_MS = 30 * 60_000;
// Tomorrow opens on prime time rather than midnight so the grid lands on
// useful content; Today intentionally has no equivalent constant — it reuses
// the "now, floored to the hour" anchor (see the Today button below).
const TOMORROW_HOUR = 18;

// v1 loads one generous page of channels per filter and virtualizes those
// rows; if the filter matches more than this, a note tells the user to
// narrow it instead of silently truncating (see the "showing N of M" note).
const CHANNEL_LIMIT = 80;

// Layout constants — fixed pixel widths (not responsive fill) so block/tick/
// now-line positions can all be expressed as simple window-relative
// percentages without ever measuring the DOM. min time-track width is
// HOURS*240px per the brief.
const CHANNEL_COL_WIDTH = 200;
const TRACK_WIDTH = HOURS * 240;
const ROW_HEIGHT = 64;
const RULER_HEIGHT = 40;

const NAV_BTN =
  "shrink-0 rounded-full border border-[var(--surface-2)] px-3 py-1 text-sm text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const NAV_ICON_BTN =
  "grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full border border-[var(--surface-2)] text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export interface TvGuideGridFilter {
  country?: string;
  category?: string;
  favorites?: boolean;
  q?: string;
}

/**
 * TiviMate-style time×channel EPG grid over a fixed HOURS-wide window.
 * Vertically virtualized (hundreds of channel rows); horizontal scroll is a
 * fixed-width track (not virtualized — HOURS is small and bounded). One
 * scroll container hosts the standard 2D sticky-grid pattern: a sticky-top
 * ruler, a sticky-left channel column, and a corner cell that's both.
 */
export default function TvGuideGrid({
  filter,
  onTune,
}: {
  filter: TvGuideGridFilter;
  onTune: (channels: TvGridChannel[], channelId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [start, setStart] = useState<Date>(() => floorToHour(new Date()));
  const windowStartMs = start.getTime();
  const windowEnd = new Date(windowStartMs + WINDOW_MS);

  const grid = useTvGrid({
    ...filter,
    start: start.toISOString(),
    hours: HOURS,
    limit: CHANNEL_LIMIT,
  });
  const channels = grid.data?.channels ?? [];
  const total = grid.data?.total ?? 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  // Reset scroll when the shared filter changes (same reasoning as
  // TvGuidePage's list view: a stale scroll position would show the new
  // filter's channels starting mid-list instead of at the top) — and when
  // the nav window (`windowStartMs`) changes, so Prev/Next/Now/Tomorrow
  // don't leave the time track scrolled to a stale horizontal offset.
  // Changing the filter's *value* deliberately still leaves `start` alone —
  // only the scroll position is reset here.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
    rowVirtualizer.scrollToOffset(0);
  }, [filter, windowStartMs, rowVirtualizer]);

  const ticks = useMemo(() => generateTimeTicks(windowStartMs, WINDOW_MS, TICK_STEP_MS), [windowStartMs]);

  // Single snapshot for the whole render — every on-air block and the
  // now-line agree (mirrors TvChannelPage's on-air snapshot pattern).
  const nowMs = Date.now();
  const nowPct = nowLinePercent(windowStartMs, WINDOW_MS, nowMs);

  const totalContentWidth = CHANNEL_COL_WIDTH + TRACK_WIDTH;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={NAV_BTN} onClick={() => setStart(floorToHour(new Date()))}>
          {t("tv:grid.now")}
        </button>
        <button
          type="button"
          className={NAV_ICON_BTN}
          aria-label={t("tv:grid.prev")}
          onClick={() => setStart((s) => shiftHours(s, -HOURS))}
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>
        <span className="min-w-[12rem] text-center text-sm tabular-nums text-[var(--text-dim)]">
          {start.toLocaleDateString(i18n.language, { weekday: "short", day: "numeric", month: "short" })} ·{" "}
          {formatTvTime(start.toISOString(), i18n.language)}–{formatTvTime(windowEnd.toISOString(), i18n.language)}
        </span>
        <button
          type="button"
          className={NAV_ICON_BTN}
          aria-label={t("tv:grid.next")}
          onClick={() => setStart((s) => shiftHours(s, HOURS))}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
        <span className="flex-1" />
        {/* Today intentionally == Now (see the TOMORROW_HOUR comment above). */}
        <button type="button" className={NAV_BTN} onClick={() => setStart(floorToHour(new Date()))}>
          {t("tv:grid.today")}
        </button>
        <button type="button" className={NAV_BTN} onClick={() => setStart(primeTimeOnDay(1, TOMORROW_HOUR))}>
          {t("tv:grid.tomorrow")}
        </button>
      </div>

      {grid.isLoading ? (
        <p className="p-4 text-[var(--text-dim)]">{t("common:status.loading")}</p>
      ) : total === 0 ? (
        <p className="p-4 text-[var(--text-dim)]">{t("tv:guidePage.empty")}</p>
      ) : (
        <>
          <div
            ref={scrollRef}
            className={cn(
              "h-[calc(100vh-360px)] overflow-auto rounded-[var(--radius)] border border-[var(--surface-2)] bg-[var(--surface)]",
              grid.isFetching && "opacity-75 transition-opacity",
            )}
          >
            <div style={{ position: "relative", width: totalContentWidth }}>
              {/* Sticky time ruler: corner cell (sticky top+left) + tick labels (sticky top only). */}
              <div className="sticky top-0 z-20 flex bg-[var(--surface)]" style={{ height: RULER_HEIGHT }}>
                <div
                  className="sticky left-0 z-10 shrink-0 border-b border-r border-[var(--surface-2)] bg-[var(--surface)]"
                  style={{ width: CHANNEL_COL_WIDTH }}
                />
                <div
                  className="relative shrink-0 overflow-hidden border-b border-[var(--surface-2)]"
                  style={{ width: TRACK_WIDTH }}
                >
                  {ticks.map((tick) => (
                    <span
                      key={tick.ms}
                      className="absolute top-0 h-full whitespace-nowrap border-l border-[var(--surface-2)] pl-1.5 text-[11px] leading-10 tabular-nums text-[var(--text-dim)]"
                      style={{ left: `${tick.leftPct}%` }}
                    >
                      {formatTvTime(new Date(tick.ms).toISOString(), i18n.language)}
                    </span>
                  ))}
                </div>
              </div>

              {/* Virtualized channel rows. */}
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {virtualItems.map((vi) => {
                  const channel = channels[vi.index]!;
                  return (
                    <div
                      key={channel.id}
                      className="absolute left-0 top-0 flex"
                      style={{ height: vi.size, width: totalContentWidth, transform: `translateY(${vi.start}px)` }}
                    >
                      {/* Sticky-left channel cell — clicking it tunes the channel. */}
                      <button
                        type="button"
                        onClick={() => onTune(channels, channel.id)}
                        aria-label={t("tv:guidePage.play", { name: channel.name })}
                        className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-b border-r border-[var(--surface-2)] bg-[var(--surface)] px-3 text-left focus-visible:z-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                        style={{ width: CHANNEL_COL_WIDTH }}
                      >
                        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-[var(--text-dim)]">
                          {channel.number}
                        </span>
                        <ChannelLogo
                          logo={channel.logo}
                          name={channel.name}
                          channelId={channel.id}
                          className="h-8 w-12 shrink-0 rounded bg-[var(--surface-2)]"
                          imgClassName="max-h-6 max-w-10"
                          monogramClassName="text-[10px] font-bold text-white/90"
                          loading="lazy"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{channel.name}</span>
                      </button>

                      {/* Time track: absolutely-positioned programme blocks. */}
                      <div className="relative shrink-0 border-b border-[var(--surface)]" style={{ width: TRACK_WIDTH }}>
                        {channel.programmes.length === 0 ? (
                          <span className="absolute inset-0 flex items-center px-3 text-xs text-[var(--text-dim)]">
                            {t("tv:guidePage.noEpg")}
                          </span>
                        ) : (
                          channel.programmes.map((p) => {
                            const rect = computeBlockRect(p, windowStartMs, WINDOW_MS);
                            if (rect.width <= 0) return null; // fully clipped by the window edge
                            const airing = Date.parse(p.start) <= nowMs && nowMs < Date.parse(p.stop);
                            const label = t("tv:grid.playProgramme", { title: p.title, channel: channel.name });
                            return (
                              <button
                                key={p.id}
                                type="button"
                                title={p.title}
                                onClick={() => onTune(channels, channel.id)}
                                aria-label={airing ? `${label} — ${t("tv:channel.onNow")}` : label}
                                style={{ left: `${rect.left}%`, width: `${rect.width}%`, top: 6, bottom: 6 }}
                                className={cn(
                                  "absolute overflow-hidden truncate rounded-[var(--radius-sm)] px-2 text-left text-xs text-[var(--text)]",
                                  "bg-[var(--surface-2)] hover:bg-white/10 focus-visible:z-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                                  airing && "bg-[var(--accent)]/20",
                                )}
                              >
                                {p.title}
                              </button>
                            );
                          })
                        )}
                        {/* Now-line: rendered per-row, inside this row's own
                            time track, instead of one outer overlay. Each
                            virtualized row's `transform` (translateY) makes
                            it establish its own stacking context, which
                            traps the row's `sticky left-0 z-10` channel cell
                            — so a later-DOM-sibling outer overlay would
                            paint on top of that trapped sticky cell, above
                            the pinned channel column, when scrolled
                            horizontally. Drawing the line inside the same
                            row (and thus the same stacking context) lets the
                            channel cell's z-10 correctly win again. Every
                            row draws its segment at the same left% so, taken
                            together, they still read as one continuous
                            vertical line down the grid. z-[5] keeps the line
                            above the programme blocks (default/z-auto
                            stacking) but below the channel cell's z-10. */}
                        {nowPct !== null && (
                          <div
                            aria-hidden
                            className="pointer-events-none absolute top-0 bottom-0 z-[5] bg-red-500"
                            style={{ left: `${nowPct}%`, width: 2 }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {total > channels.length && (
            <p className="text-xs text-[var(--text-dim)]">
              {t("tv:grid.showingOf", { shown: channels.length, total })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
