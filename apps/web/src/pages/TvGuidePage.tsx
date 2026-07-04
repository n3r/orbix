import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, focusRingInset, Input } from "@orbix/ui";
import { useTvGuide } from "@/lib/queries";
import type { TvChannelCard, TvGridChannel } from "@/lib/types";
import LiveTvOverlay from "@/components/tv/LiveTvOverlay";
import { ChannelNowNext } from "@/components/tv/ChannelNowNext";
import { ChannelLogo } from "@/components/tv/ChannelLogo";
import TvGuideGrid from "@/components/tv/TvGuideGrid";
import { regionName } from "@/lib/tv";
import { InfoIcon } from "@/components/shell/icons";

type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "country"; code: string }
  | { kind: "category"; id: string };

type GuideView = "list" | "grid";
const GUIDE_VIEW_STORAGE_KEY = "orbix.tv.guideView";

/** Reads the last-chosen guide view, guarded for SSR/private-mode (no localStorage). */
function initialGuideView(): GuideView {
  try {
    return localStorage.getItem(GUIDE_VIEW_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list"; // no localStorage — default, in-memory only for this session
  }
}

// Taller than a plain single-line row (72 vs. 64) to fit the now/next block
// (title + time, thin progress bar, next line) added below the channel name
// without clipping inside the virtualizer's fixed-height rows.
const ROW_HEIGHT = 72;

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-3 py-1 text-sm transition-colors",
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]"
          : "border-[var(--surface-2)] text-[var(--text-dim)] hover:text-[var(--text)]",
      )}
    >
      {children}
    </button>
  );
}

export default function TvGuidePage() {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [playing, setPlaying] = useState<{ channels: TvChannelCard[]; id: string } | null>(null);
  const [view, setViewState] = useState<GuideView>(initialGuideView);

  // Persists across visits (default "list"); guarded the same way as the read.
  const setView = useCallback((next: GuideView) => {
    setViewState(next);
    try {
      localStorage.setItem(GUIDE_VIEW_STORAGE_KEY, next);
    } catch {
      /* no localStorage — the choice just won't survive this session */
    }
  }, []);

  // 300 ms search debounce.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params = useMemo(
    () => ({
      country: filter.kind === "country" ? filter.code : undefined,
      category: filter.kind === "category" ? filter.id : undefined,
      favorites: filter.kind === "favorites" ? true : undefined,
      q: debouncedQ || undefined,
    }),
    [filter, debouncedQ],
  );
  const guide = useTvGuide(params);
  const channels = useMemo(
    () => (guide.data?.pages ?? []).flatMap((p) => p.channels),
    [guide.data],
  );
  const total = guide.data?.pages[0]?.total ?? 0;

  // v1 facets: derived client-side from the UNFILTERED first page (that IS the
  // default query, so it's cached the moment the page loads — no extra fetch).
  const base = useTvGuide({});
  const chips = useMemo(() => {
    const rows = base.data?.pages[0]?.channels ?? [];
    const countries = new Set<string>();
    const categories = new Set<string>();
    for (const c of rows) {
      if (c.country) countries.add(c.country);
      for (const cat of c.categories) categories.add(cat);
    }
    return { countries: [...countries].sort(), categories: [...categories].sort() };
  }, [base.data]);

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  // Reset scroll on every filter/search change. TanStack Query can keep the
  // virtualized list mounted with its previous scrollTop when the new query
  // key is already cached (e.g. flipping back to "All", which shares the
  // unfiltered `base` query below) — without this, a filter switch can land
  // the user mid-list instead of at the top of the new results.
  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
    rowVirtualizer.scrollToOffset(0);
  }, [filter, debouncedQ, rowVirtualizer]);

  // Offset paging: pull the next 100 as the list nears its loaded end.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = guide;
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= channels.length - 20 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [virtualItems, channels.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // The grid opens the player exactly like a list row does; it just hands
  // back its own (now/next-less) channel shape, so bridge it to the
  // TvChannelCard-shaped zap context LiveTvOverlay expects.
  const handleGridTune = useCallback((gridChannels: TvGridChannel[], id: string) => {
    setPlaying({ channels: gridChannels.map((c) => ({ ...c, now: null, next: null })), id });
  }, []);

  return (
    <main
      className={cn(
        "mx-auto flex w-full flex-col gap-4 px-4 py-6 md:px-8",
        view === "grid" ? "max-w-7xl" : "max-w-5xl",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-[var(--text)]">{t("tv:guidePage.title")}</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--text-dim)]">
            {t("tv:guidePage.channelCount", { count: total })}
          </span>
          <div className="flex gap-2">
            <Chip active={view === "list"} onClick={() => setView("list")}>
              {t("tv:guidePage.viewList")}
            </Chip>
            <Chip active={view === "grid"} onClick={() => setView("grid")}>
              {t("tv:guidePage.viewGrid")}
            </Chip>
          </div>
        </div>
      </div>

      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("tv:guidePage.searchPlaceholder")}
        aria-label={t("tv:guidePage.searchPlaceholder")}
      />

      <div className="scrollbar-none flex gap-2 overflow-x-auto py-1">
        <Chip active={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })}>
          {t("tv:guidePage.all")}
        </Chip>
        <Chip active={filter.kind === "favorites"} onClick={() => setFilter({ kind: "favorites" })}>
          {t("tv:guidePage.favorites")}
        </Chip>
        {chips.countries.map((code) => (
          <Chip
            key={code}
            active={filter.kind === "country" && filter.code === code}
            onClick={() => setFilter({ kind: "country", code })}
          >
            {regionName(code, i18n.language) ?? code}
          </Chip>
        ))}
        {chips.categories.map((cat) => (
          <Chip
            key={cat}
            active={filter.kind === "category" && filter.id === cat}
            onClick={() => setFilter({ kind: "category", id: cat })}
          >
            {t(`tv:categories.${cat}`, { defaultValue: cat.charAt(0).toUpperCase() + cat.slice(1) })}
          </Chip>
        ))}
      </div>

      {view === "grid" && <TvGuideGrid filter={params} onTune={handleGridTune} />}

      {view === "list" &&
        (guide.isLoading ? (
          <p className="p-4 text-[var(--text-dim)]">{t("common:status.loading")}</p>
        ) : channels.length === 0 ? (
          <p className="p-4 text-[var(--text-dim)]">{t("tv:guidePage.empty")}</p>
        ) : (
          <div
            ref={parentRef}
            className="h-[calc(100vh-260px)] overflow-y-auto rounded-[var(--radius)] border border-[var(--surface-2)]"
          >
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
              {virtualItems.map((vi) => {
                const c = channels[vi.index]!;
                return (
                  <div
                    key={c.id}
                    className="group absolute left-0 top-0 flex w-full items-center gap-3 overflow-hidden border-b border-[var(--surface)] px-3"
                    style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
                  >
                    <span className="w-10 shrink-0 text-right text-sm tabular-nums text-[var(--text-dim)]">
                      {c.number}
                    </span>
                    <ChannelLogo
                      logo={c.logo}
                      name={c.name}
                      channelId={c.id}
                      className="h-9 w-14 shrink-0 rounded bg-[var(--surface)]"
                      imgClassName="max-h-7 max-w-11"
                      monogramClassName="text-xs font-bold text-white/90"
                      loading="lazy"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--text)]">{c.name}</span>
                      <ChannelNowNext now={c.now} next={c.next} />
                    </span>
                    {c.quality && (
                      <span className="shrink-0 rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-dim)]">
                        {c.quality}
                      </span>
                    )}

                    {/* Whole row tunes (painted above the cells — later sibling). */}
                    <button
                      type="button"
                      onClick={() => setPlaying({ channels, id: c.id })}
                      aria-label={t("tv:guidePage.play", { name: c.name })}
                      className={cn("absolute inset-0 hover:bg-white/5", focusRingInset)}
                    />
                    {/* Channel-details affordance, painted above the row button. */}
                    <Link
                      to={`/tv/channel/${c.id}`}
                      aria-label={t("tv:guidePage.schedule")}
                      className="relative shrink-0 rounded p-1 text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    >
                      <InfoIcon className="h-4 w-4" />
                    </Link>
                  </div>
                );
              })}
            </div>
            {isFetchingNextPage && (
              <p className="p-3 text-center text-sm text-[var(--text-dim)]">{t("common:status.loading")}</p>
            )}
          </div>
        ))}

      {playing && (
        <LiveTvOverlay
          channels={playing.channels}
          initialId={playing.id}
          onClose={() => setPlaying(null)}
        />
      )}
    </main>
  );
}
