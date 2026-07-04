import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MediaPlayer,
  MediaProvider,
  isHLSProvider,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import Hls from "hls.js";
import type { ErrorData } from "hls.js";
import { apiFetch, apiJson } from "@/lib/api";
import type { TvPlayResponse } from "@/lib/types";

/**
 * hls.js live tuning (spec §Player): tight manifest policy so a dead channel
 * fails within seconds (zap UX); patient fragment policy so a flaky-but-alive
 * origin gets retries; small live sync window with mild catch-up.
 */
const HLS_LIVE_CONFIG = {
  liveSyncDurationCount: 4,
  liveMaxLatencyDurationCount: 12,
  maxLiveSyncPlaybackRate: 1.2,
  manifestLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 8000,
      maxLoadTimeMs: 20000,
      timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
    },
  },
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 10000,
      maxLoadTimeMs: 60000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
    },
  },
};

const HEALTH_OK_AFTER_MS = 30_000;
const TOAST_MS = 4_000;

interface Props {
  channelId: string;
  /** Bump to re-tune the same channel from source 0 (offline-panel Retry). */
  attempt: number;
  /** Channel meta + active source index, for the overlay's OSD. */
  onInfo: (info: { play: TvPlayResponse; sourceIndex: number }) => void;
  /** Imperative surface for the overlay ("l" key → live edge). */
  onControls: (controls: { seekToLiveEdge: () => void }) => void;
  /** Every source failed (or no playable stream) — overlay shows the offline panel. */
  onSourcesExhausted: () => void;
}

/**
 * Live-TV player — sibling of the VOD Player sharing the Vidstack layout, not
 * its VOD logic: no decision endpoint, no subtitle fetch, no progress PUTs.
 * Sources come pre-ordered from /tv/channels/:id/play and are tried in order.
 */
export default function LiveTvPlayer({ channelId, attempt, onInfo, onControls, onSourcesExhausted }: Props) {
  const { t } = useTranslation();
  const [play, setPlay] = useState<TvPlayResponse | null>(null);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const playerRef = useRef<MediaPlayerInstance>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retriedNetworkRef = useRef(false);
  const recoveredMediaRef = useRef(false);
  const healthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportedOkRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const source = play?.sources[sourceIndex] ?? null;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const postHealth = useCallback((streamId: string, ok: boolean, code?: string) => {
    void apiFetch(`/tv/streams/${streamId}/health`, {
      method: "POST",
      body: JSON.stringify(code ? { ok, code } : { ok }),
    }).catch(() => {});
  }, []);

  // ── Tune: log the play event (recents) and fetch the ordered sources ────
  useEffect(() => {
    let cancelled = false;
    setPlay(null);
    setSourceIndex(0);
    void apiFetch(`/tv/events/${channelId}`, { method: "POST" }).catch(() => {});
    apiJson<TvPlayResponse>(`/tv/channels/${channelId}/play`)
      .then((p) => {
        if (cancelled) return;
        if (p.sources.length === 0) onSourcesExhausted();
        else setPlay(p);
      })
      .catch(() => {
        // 409 no_playable_stream, 404, network — all land on the offline panel.
        if (!cancelled) onSourcesExhausted();
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, attempt, onSourcesExhausted]);

  // Surface channel meta + active source to the overlay OSD.
  useEffect(() => {
    if (play) onInfo({ play, sourceIndex });
  }, [play, sourceIndex, onInfo]);

  // Imperative live-edge control for the overlay's "l" key.
  useEffect(() => {
    onControls({
      seekToLiveEdge: () => {
        const player = playerRef.current;
        if (!player) return;
        const end = player.state.seekableEnd;
        if (Number.isFinite(end) && end > 1) player.currentTime = end - 1;
      },
    });
  }, [onControls]);

  // Reset the per-source error ladder + health state on source change.
  useEffect(() => {
    retriedNetworkRef.current = false;
    recoveredMediaRef.current = false;
    reportedOkRef.current = false;
    return () => {
      if (healthTimerRef.current) {
        clearTimeout(healthTimerRef.current);
        healthTimerRef.current = null;
      }
    };
  }, [source?.streamId, attempt]);

  const advanceSource = useCallback(
    (code: string) => {
      if (!play || !source) return;
      postHealth(source.streamId, false, code); // every failed source bumps failCount
      if (healthTimerRef.current) {
        clearTimeout(healthTimerRef.current);
        healthTimerRef.current = null;
      }
      const next = sourceIndex + 1;
      if (next < play.sources.length) {
        showToast(t("tv:player.tryingSource", { n: next + 1, total: play.sources.length }));
        setSourceIndex(next);
      } else {
        onSourcesExhausted();
      }
    },
    [play, source, sourceIndex, postHealth, showToast, onSourcesExhausted, t],
  );

  // Error ladder (spec §Player): fatal NETWORK → one startLoad() retry → next
  // source; fatal MEDIA → one recoverMediaError() → next source; anything
  // else fatal → next source. Never silent: toasts accompany every rung.
  const onHlsError = useCallback(
    (data: ErrorData) => {
      if (!data.fatal) return;
      const hls = hlsRef.current;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && hls && !retriedNetworkRef.current) {
        retriedNetworkRef.current = true;
        showToast(t("tv:player.reconnecting"));
        if (healthTimerRef.current) {
          clearTimeout(healthTimerRef.current);
          healthTimerRef.current = null;
        }
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hls && !recoveredMediaRef.current) {
        recoveredMediaRef.current = true;
        showToast(t("tv:player.reconnecting"));
        if (healthTimerRef.current) {
          clearTimeout(healthTimerRef.current);
          healthTimerRef.current = null;
        }
        hls.recoverMediaError();
        return;
      }
      advanceSource(data.details);
    },
    [advanceSource, showToast, t],
  );

  // ≥30 s of successful playback → report the stream healthy, once per tune.
  const onPlaying = useCallback(() => {
    if (reportedOkRef.current || healthTimerRef.current || !source) return;
    const streamId = source.streamId;
    healthTimerRef.current = setTimeout(() => {
      healthTimerRef.current = null;
      reportedOkRef.current = true;
      postHealth(streamId, true);
    }, HEALTH_OK_AFTER_MS);
  }, [source, postHealth]);

  // Pause→resume on live parks behind the window (vidstack #1623): nudge the
  // player instance back to the live edge whenever play resumes off-edge.
  const onPlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const { liveEdge, seekableEnd } = player.state;
    if (!liveEdge && Number.isFinite(seekableEnd) && seekableEnd > 1) {
      player.currentTime = seekableEnd - 1;
    }
  }, []);

  // Wire the BUNDLED hls.js (offline guarantee — never the CDN default) and
  // the live load policies before the provider loads. Mirrors Player.tsx.
  const onProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (provider && isHLSProvider(provider)) {
      provider.library = Hls;
      provider.config = HLS_LIVE_CONFIG;
    }
  }, []);

  if (!play || !source) {
    return (
      <div className="grid h-full w-full place-items-center text-sm text-[var(--text-dim)]">
        {t("tv:player.loading")}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <MediaPlayer
        key={`${source.streamId}:${attempt}`}
        ref={playerRef}
        title={play.channel.name}
        src={{ src: source.src, type: "application/x-mpegurl" }}
        streamType="live"
        className="h-full w-full bg-black"
        style={{ "--media-brand": "var(--accent)" }}
        autoPlay
        playsInline
        keyTarget="document"
        onProviderChange={onProviderChange}
        onHlsInstance={(hls) => {
          hlsRef.current = hls;
        }}
        onHlsError={onHlsError}
        onPlaying={onPlaying}
        onPlay={onPlay}
      >
        <MediaProvider />
        <DefaultVideoLayout icons={defaultLayoutIcons} colorScheme="dark" />
      </MediaPlayer>

      {toast && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-sm text-white">
          {toast}
        </div>
      )}
    </div>
  );
}
