import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@orbix/ui";
import type { TvChannelCard, TvPlayResponse } from "@/lib/types";
import LiveTvPlayer from "./LiveTvPlayer";
import { NowProgressBar } from "./NowProgressBar";
import { ChannelNowNext } from "./ChannelNowNext";
import { ChannelLogo } from "./ChannelLogo";
import { ChevronDownIcon } from "@/components/shell/icons";

const OSD_MS = 4_000;

interface Props {
  /** Zap context: the exact channel list the opener was showing, in order. */
  channels: TvChannelCard[];
  initialId: string;
  onClose: () => void;
}

/**
 * Full-page live-TV cinema — portal over the app shell like PlayerOverlay.
 * Hosts LiveTvPlayer plus: zap OSD (auto-hide 4 s), "g" mini-guide drawer,
 * offline panel, and the keyboard surface:
 *   PageUp/PageDown & Shift+↑/↓  zap within the passed channel list
 *   Backspace                    last-channel toggle
 *   g                            mini-guide (↑/↓ move, Enter tunes in place, Esc closes)
 *   l                            seek to live edge
 *   i                            re-show the OSD
 *   Esc                          close drawer, else close overlay (fullscreen exits first)
 */
export default function LiveTvOverlay({ channels, initialId, onClose }: Props) {
  const { t } = useTranslation();
  const [currentId, setCurrentId] = useState(initialId);
  const [attempt, setAttempt] = useState(0);
  const [offline, setOffline] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideIndex, setGuideIndex] = useState(0);
  const [osdVisible, setOsdVisible] = useState(true);
  const [info, setInfo] = useState<{ play: TvPlayResponse; sourceIndex: number } | null>(null);

  const prevIdRef = useRef<string | null>(null);
  const controlsRef = useRef<{ seekToLiveEdge: () => void } | null>(null);
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guideRowRef = useRef<HTMLButtonElement | null>(null);

  const current = channels.find((c) => c.id === currentId) ?? channels[0] ?? null;

  // ── OSD: shown on every tune and on "i", auto-hides after 4 s ───────────
  const showOsd = useCallback(() => {
    setOsdVisible(true);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsdVisible(false), OSD_MS);
  }, []);
  useEffect(() => {
    showOsd(); // fires on mount and on every channel change
  }, [currentId, showOsd]);
  useEffect(
    () => () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    },
    [],
  );

  const tune = useCallback((id: string) => {
    setCurrentId((prev) => {
      if (prev !== id) prevIdRef.current = prev; // Backspace target
      return id;
    });
    setOffline(false);
    setAttempt(0);
    setInfo(null);
  }, []);

  const zap = useCallback(
    (delta: number) => {
      if (channels.length === 0) return;
      const idx = channels.findIndex((c) => c.id === currentId);
      const next = ((idx < 0 ? 0 : idx) + delta + channels.length) % channels.length;
      tune(channels[next]!.id);
    },
    [channels, currentId, tune],
  );

  // Lock background scroll while the overlay is open (PlayerOverlay pattern).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // ── Keyboard surface (all listeners removed on unmount) ─────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;

      if (e.key === "Escape") {
        if (document.fullscreenElement) return; // first Esc exits fullscreen
        e.preventDefault();
        if (guideOpen) setGuideOpen(false);
        else onClose();
        return;
      }
      if (e.key === "PageUp" || (e.shiftKey && e.key === "ArrowUp")) {
        e.preventDefault();
        zap(-1);
        return;
      }
      if (e.key === "PageDown" || (e.shiftKey && e.key === "ArrowDown")) {
        e.preventDefault();
        zap(1);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        if (prevIdRef.current) tune(prevIdRef.current);
        return;
      }
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        if (guideOpen) {
          setGuideOpen(false);
        } else {
          setGuideIndex(Math.max(0, channels.findIndex((c) => c.id === currentId)));
          setGuideOpen(true);
        }
        return;
      }
      if (e.key === "l" || e.key === "L") {
        controlsRef.current?.seekToLiveEdge();
        return;
      }
      if (e.key === "i" || e.key === "I") {
        showOsd();
        return;
      }
      if (guideOpen) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setGuideIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setGuideIndex((i) => Math.min(channels.length - 1, i + 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const c = channels[guideIndex];
          if (c) tune(c.id); // tunes in place; the drawer stays open
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [channels, currentId, guideIndex, guideOpen, onClose, showOsd, tune, zap]);

  // Keep the focused mini-guide row in view.
  useEffect(() => {
    if (guideOpen) guideRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [guideIndex, guideOpen]);

  const handleInfo = useCallback((next: { play: TvPlayResponse; sourceIndex: number }) => {
    setInfo(next);
  }, []);
  const handleControls = useCallback((c: { seekToLiveEdge: () => void }) => {
    controlsRef.current = c;
  }, []);
  const handleExhausted = useCallback(() => {
    setOffline(true);
  }, []);

  if (!current) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black">
      {!offline && (
        <LiveTvPlayer
          channelId={current.id}
          attempt={attempt}
          onInfo={handleInfo}
          onControls={handleControls}
          onSourcesExhausted={handleExhausted}
        />
      )}

      {/* Offline panel — every source failed (health already reported by the player). */}
      {offline && (
        <div className="grid h-full w-full place-items-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-lg font-medium text-white">{t("tv:player.offline")}</p>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  setOffline(false);
                  setAttempt((a) => a + 1);
                }}
              >
                {t("common:actions.retry")}
              </Button>
              <Button variant="ghost" onClick={() => zap(1)}>
                {t("tv:player.nextChannel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Zap OSD: number · logo · name · quality · source indicator · now/next */}
      {osdVisible && (
        <div className="pointer-events-none absolute left-4 top-14 z-10 flex max-w-[min(90vw,28rem)] items-center gap-3 rounded-lg bg-black/70 px-4 py-3 backdrop-blur">
          <span className="shrink-0 text-2xl font-bold tabular-nums text-white/80">{current.number}</span>
          <ChannelLogo
            logo={current.logo}
            name={current.name}
            channelId={current.id}
            className="h-10 w-14 shrink-0 rounded bg-white/10"
            imgClassName="max-h-8 max-w-12"
            monogramClassName="text-sm font-bold text-white"
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-base font-semibold text-white">{current.name}</span>
            <span className="flex items-center gap-2 text-xs text-white/60">
              {current.quality && (
                <span className="rounded-sm bg-white/15 px-1 py-0.5 font-semibold">{current.quality}</span>
              )}
              {info && info.sourceIndex > 0 && (
                <span>{t("tv:player.source", { n: info.sourceIndex + 1, total: info.play.sources.length })}</span>
              )}
            </span>
            {info?.play.nowNext.now && (
              <span className="mt-1 min-w-0">
                <span className="block truncate text-xs text-white/80">{info.play.nowNext.now.title}</span>
                <NowProgressBar start={info.play.nowNext.now.start} stop={info.play.nowNext.now.stop} />
              </span>
            )}
            {info?.play.nowNext.next && (
              <span className="block truncate text-[11px] text-white/50">
                {t("tv:player.next")} · {info.play.nowNext.next.title}
              </span>
            )}
          </span>
        </div>
      )}

      {/* Mini-guide drawer ("g"): the zap context's channels, Enter tunes in place */}
      {guideOpen && (
        <div
          role="dialog"
          aria-label={t("tv:player.miniGuide")}
          className="absolute inset-y-0 left-0 z-20 flex w-80 max-w-[80vw] flex-col border-r border-white/10 bg-black/85 backdrop-blur"
        >
          <p className="px-4 pb-2 pt-4 text-xs uppercase tracking-wide text-white/50">
            {t("tv:player.miniGuide")}
          </p>
          <div className="flex-1 overflow-y-auto pb-4">
            {channels.map((c, i) => (
              <button
                key={c.id}
                ref={i === guideIndex ? guideRowRef : undefined}
                type="button"
                onClick={() => tune(c.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2 text-left",
                  c.id === currentId ? "bg-[var(--accent)]/20 text-white" : "text-white/80 hover:bg-white/10",
                  i === guideIndex && "ring-1 ring-inset ring-[var(--accent)]",
                )}
              >
                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-white/50">{c.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 block text-sm">{c.name}</span>
                  <ChannelNowNext now={c.now} next={c.next} />
                </span>
                {c.quality && <span className="shrink-0 text-[10px] text-white/40">{c.quality}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Close affordance — top-left, above everything (PlayerOverlay pattern). */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("tv:player.close")}
        className="absolute left-3 top-3 z-30 grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/70 hover:text-white"
      >
        <ChevronDownIcon className="h-6 w-6" />
      </button>
    </div>,
    document.body,
  );
}
