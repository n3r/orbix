import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  MediaPlayer,
  MediaProvider,
  Track,
  SeekButton,
  isHLSProvider,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import { SeekBackward10Icon, SeekForward30Icon } from "@vidstack/react/icons";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import Hls from "hls.js";
import { Button } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

interface Decision {
  mode: string;
  url: string;
  qualities?: QualityOption[];
  audioModes?: AudioModeOption[];
}

interface QualityOption {
  id: string;
  label: string;
  type: "direct" | "hls";
  url: string;
  hlsUrl?: string;
}

type AudioMode = "standard" | "leveled";

interface AudioModeOption {
  id: AudioMode;
  label: string;
}

interface SubTrack {
  index: number;
  codec: string;
  language?: string;
  label?: string;
  burnIn: boolean;
}

interface Progress {
  positionSec: number;
  durationSec: number;
  finished: boolean;
}

interface Props {
  fileId: string;
  mediaItemId: string;
  title: string;
  /** Set for TV episodes so progress is keyed per-episode (movies omit it). */
  episodeId?: string;
}

const SAVE_INTERVAL_MS = 10_000;

export default function Player({ fileId, mediaItemId, title, episodeId }: Props) {
  const { t } = useTranslation();
  const progressQuery = episodeId
    ? `?episodeId=${encodeURIComponent(episodeId)}`
    : "";

  // The default large (desktop) layout renders no on-screen seek buttons, so add
  // a Netflix/Plex-style −10s / +30s pair flanking the play button (via the large
  // layout's before/after-play-button slots). Uses the matching numbered seek
  // icons and the default layout's button CSS classes so they sit seamlessly in
  // the control bar. Keyboard seeking uses `seekStep` (see below).
  const seekBackward10 = (
    <SeekButton
      seconds={-10}
      className="vds-seek-button vds-button"
      aria-label={t("player:seek.backward", { seconds: 10 })}
    >
      <SeekBackward10Icon className="vds-icon" />
    </SeekButton>
  );
  const seekForward30 = (
    <SeekButton
      seconds={30}
      className="vds-seek-button vds-button"
      aria-label={t("player:seek.forward", { seconds: 30 })}
    >
      <SeekForward30Icon className="vds-icon" />
    </SeekButton>
  );

  const [decision, setDecision] = useState<Decision | null>(null);
  const [subs, setSubs] = useState<SubTrack[]>([]);
  const [resume, setResume] = useState<Progress | null>(null);
  const [selectedQuality, setSelectedQuality] = useState("source");
  const [audioMode, setAudioMode] = useState<AudioMode>("standard");
  const [selectedSubtitle, setSelectedSubtitle] = useState("off");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again": re-runs the decision fetch and remounts the player.
  const [attempt, setAttempt] = useState(0);

  const playerRef = useRef<MediaPlayerInstance>(null);
  const resumedRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);

  // Fetch decision, subtitle tracks, and saved progress on mount / retry
  useEffect(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [decisionRes, subsRes, progressRes] = await Promise.all([
          apiFetch(`/play/${fileId}/decision`),
          apiFetch(`/play/${fileId}/subs`),
          apiFetch(`/items/${mediaItemId}/progress${progressQuery}`),
        ]);

        if (!decisionRes.ok) {
          setError(t("player:error.decision"));
          return;
        }
        const d = (await decisionRes.json()) as Decision;
        setDecision(d);
        setSelectedQuality(d.qualities?.find((q) => q.id === "source")?.id ?? d.qualities?.[0]?.id ?? "source");
        setAudioMode("standard");

        if (subsRes.ok) {
          const s = (await subsRes.json()) as SubTrack[];
          setSubs(s);
        }

        if (progressRes.ok) {
          const p = (await progressRes.json()) as Progress;
          setResume(p);
        }
      } catch {
        setError(t("player:error.network"));
      } finally {
        setLoading(false);
      }
    })();
  }, [fileId, mediaItemId, progressQuery, t, attempt]);

  useEffect(() => {
    if (selectedSubtitle === "off") return;
    if (!subs.some((s) => !s.burnIn && String(s.index) === selectedSubtitle)) {
      setSelectedSubtitle("off");
    }
  }, [selectedSubtitle, subs]);

  // Save progress to the server (reads live state from the player ref)
  const saveProgress = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return;
    const pos = player.state.currentTime;
    const dur = player.state.duration;
    if (dur <= 0) return;
    try {
      await apiFetch(`/items/${mediaItemId}/progress`, {
        method: "PUT",
        body: JSON.stringify({ positionSec: pos, durationSec: dur, episodeId }),
      });
    } catch {
      // Ignore transient save errors
    }
  }, [mediaItemId, episodeId]);

  // Periodic progress save (every 10s while playing)
  useEffect(() => {
    if (!decision) return;
    const id = setInterval(async () => {
      const player = playerRef.current;
      if (!player || player.state.paused || player.state.duration <= 0) return;
      await saveProgress();
    }, SAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [decision, saveProgress]);

  // Save on page hide (tab switch, close) and on unmount
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") void saveProgress();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      void saveProgress();
    };
  }, [saveProgress]);

  // Wire up the bundled hls.js so HLS playback works offline (no CDN fetch).
  // This fires before the provider loads, so setting provider.library here
  // ensures Vidstack uses the bundled constructor rather than its CDN default.
  const onProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (provider && isHLSProvider(provider)) {
      provider.library = Hls;
    }
  }, []);

  // Resume: seek to saved position when the player is ready
  const handleCanPlay = useCallback(() => {
    if (pendingSeekRef.current !== null) {
      const seekTo = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (seekTo > 0) playerRef.current?.remoteControl.seek(seekTo);
      return;
    }
    if (resumedRef.current) return;
    if (!resume || resume.positionSec <= 0 || resume.finished) return;
    resumedRef.current = true;
    playerRef.current?.remoteControl.seek(resume.positionSec);
  }, [resume]);

  // Save progress when the user pauses
  const handlePause = useCallback(() => {
    void saveProgress();
  }, [saveProgress]);

  const rememberPlaybackTime = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    pendingSeekRef.current = player.state.currentTime;
  }, []);

  // A runtime playback failure (codec/append/segment error mid-play) would
  // otherwise leave a black frame forever. Surface it and let the user retry
  // from where it stopped.
  const handlePlaybackError = useCallback(() => {
    rememberPlaybackTime();
    setError(t("player:error.playback"));
  }, [rememberPlaybackTime, t]);

  const handleRetry = useCallback(() => {
    resumedRef.current = false;
    setAttempt((n) => n + 1);
  }, []);

  if (loading) {
    return (
      <div className="grid h-full w-full place-items-center text-sm text-[var(--text-dim)]">
        {t("player:loading")}
      </div>
    );
  }

  if (error || !decision) {
    return (
      <div className="grid h-full w-full place-items-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <p className="text-base font-medium text-[var(--text)]">
            {error ?? t("player:error.generic")}
          </p>
          <Button onClick={handleRetry}>{t("common:actions.retry")}</Button>
        </div>
      </div>
    );
  }

  const textTracks = subs.filter((s) => !s.burnIn);
  const selectedTrack =
    selectedSubtitle === "off"
      ? null
      : textTracks.find((track) => String(track.index) === selectedSubtitle) ?? null;
  const qualityOptions =
    decision.qualities && decision.qualities.length > 0
      ? decision.qualities
      : [
          {
            id: "source",
            label: "Original",
            type: decision.mode === "direct" ? "direct" : "hls",
            url: decision.url,
            hlsUrl: decision.url,
          } satisfies QualityOption,
        ];
  const activeQuality =
    qualityOptions.find((quality) => quality.id === selectedQuality) ?? qualityOptions[0];
  const audioModes =
    decision.audioModes && decision.audioModes.length > 0
      ? decision.audioModes
      : [
          { id: "standard" as const, label: t("player:audio.standard") },
          { id: "leveled" as const, label: t("player:audio.leveling") },
        ];
  const audioLevelingAvailable = audioModes.some((mode) => mode.id === "leveled");
  const sourceIsDirect = activeQuality.type === "direct" && audioMode === "standard";
  const sourceUrl =
    activeQuality.id === "auto"
      ? `/api/play/${fileId}/master.m3u8?audio=${audioMode}`
      : sourceIsDirect
        ? activeQuality.url
        : `/api/play/${fileId}/hls/${activeQuality.id}/${audioMode}/index.m3u8`;
  const sourceType = sourceIsDirect ? "video/mp4" : "application/x-mpegurl";

  const handleQualityChange = (value: string) => {
    if (value === selectedQuality) return;
    rememberPlaybackTime();
    setSelectedQuality(value);
  };

  const handleAudioModeChange = (enabled: boolean) => {
    const next = enabled ? "leveled" : "standard";
    if (next === audioMode) return;
    rememberPlaybackTime();
    setAudioMode(next);
  };

  return (
    <MediaPlayer
      key={`${sourceUrl}#${attempt}`}
      ref={playerRef}
      title={title}
      src={{ src: sourceUrl, type: sourceType }}
      className="relative h-full w-full bg-black"
      style={{ "--media-brand": "var(--accent)" }}
      autoPlay
      playsInline
      keyTarget="document"
      onProviderChange={onProviderChange}
      onCanPlay={handleCanPlay}
      onPause={handlePause}
      onError={handlePlaybackError}
    >
      <MediaProvider>
        {selectedTrack && (
          <Track
            key={String(selectedTrack.index)}
            src={`/api/play/${fileId}/subs/${selectedTrack.index}.vtt`}
            kind="subtitles"
            label={selectedTrack.label ?? selectedTrack.language ?? t("player:track.label", { index: selectedTrack.index })}
            language={selectedTrack.language ?? ""}
            default
          />
        )}
      </MediaProvider>
      <DefaultVideoLayout
        icons={defaultLayoutIcons}
        colorScheme="dark"
        seekStep={10}
        slots={{ largeLayout: { beforePlayButton: seekBackward10, afterPlayButton: seekForward30 } }}
      />
      <div className="pointer-events-none absolute left-16 right-3 top-3 z-10 flex flex-wrap justify-end gap-2 text-[11px] font-medium text-white/85 sm:left-auto sm:text-xs">
        <label className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/15 bg-black/55 px-2.5 py-2 shadow-lg backdrop-blur-md">
          <span>{t("player:controls.quality")}</span>
          <select
            aria-label={t("player:controls.quality")}
            value={activeQuality.id}
            onChange={(event) => handleQualityChange(event.target.value)}
            className="max-w-32 rounded border border-white/15 bg-black/70 px-2 py-1 text-white outline-none transition-colors focus:border-[var(--accent)]"
          >
            {qualityOptions.map((quality) => (
              <option key={quality.id} value={quality.id}>
                {quality.id === "auto" ? t("player:quality.auto") : quality.label}
              </option>
            ))}
          </select>
        </label>

        <label className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/15 bg-black/55 px-2.5 py-2 shadow-lg backdrop-blur-md">
          <span>{t("player:controls.subtitles")}</span>
          <select
            aria-label={t("player:controls.subtitles")}
            value={selectedSubtitle}
            onChange={(event) => setSelectedSubtitle(event.target.value)}
            disabled={textTracks.length === 0}
            className="max-w-36 rounded border border-white/15 bg-black/70 px-2 py-1 text-white outline-none transition-colors disabled:cursor-not-allowed disabled:text-white/45 focus:border-[var(--accent)]"
          >
            <option value="off">{t("player:subtitles.off")}</option>
            {textTracks.map((track) => (
              <option key={track.index} value={String(track.index)}>
                {track.label ?? track.language ?? t("player:track.label", { index: track.index })}
              </option>
            ))}
          </select>
        </label>

        <label className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/15 bg-black/55 px-2.5 py-2 shadow-lg backdrop-blur-md">
          <input
            type="checkbox"
            aria-label={t("player:audio.leveling")}
            checked={audioMode === "leveled"}
            disabled={!audioLevelingAvailable}
            onChange={(event) => handleAudioModeChange(event.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span>{t("player:audio.leveling")}</span>
        </label>
      </div>
    </MediaPlayer>
  );
}
