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

type AudioMode = "standard" | "leveled";

interface QualityOption {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
  bandwidth: number;
}

interface AudioModeOption {
  id: AudioMode;
  label: string;
}

interface AudioTrackInfo {
  index: number;
  codec?: string;
  channels?: number;
  language?: string;
  selected: boolean;
}

interface SubtitleTrackInfo {
  index: number;
  codec?: string;
  language?: string;
  label?: string;
  available: boolean;
  reason?: string;
}

interface PlaybackInfo {
  playSessionId: string;
  mode: string;
  streamUrl: string;
  /** The quality/audio mode the server actually used for this session. */
  quality: string;
  audioMode: AudioMode;
  qualities: QualityOption[];
  audioModes: AudioModeOption[];
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
}

const WEB_CAPABILITIES = {
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxAudioChannels: 2,
  hlsMultichannelAacBroken: true,
  // The player renders its own sidecar <Track> elements below (from
  // playbackInfo.subtitleTracks), so the master playlist must NOT also emit
  // EXT-X-MEDIA subtitle renditions — that would duplicate the subtitle menu.
  subtitleDelivery: "sidecar" as const,
};

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

  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [resume, setResume] = useState<Progress | null>(null);
  const [selectedQuality, setSelectedQuality] = useState("source");
  const [audioMode, setAudioMode] = useState<AudioMode>("standard");
  const [selectedSubtitle, setSelectedSubtitle] = useState("off");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again": re-runs negotiation and remounts the player.
  const [attempt, setAttempt] = useState(0);

  const playerRef = useRef<MediaPlayerInstance>(null);
  const resumedRef = useRef(false);
  const infoRef = useRef<PlaybackInfo | null>(null);
  // Position to restore after a quality/audio-mode switch remounts the player
  // (the new stream is a brand-new session that starts at 0).
  const pendingSeekRef = useRef<number | null>(null);

  // Negotiate playback for a given quality + audio mode. Each call mints a
  // fresh play session (playSessionId) server-side; the response carries the
  // stream URL, server-decided track lists, and the quality/audio ladders.
  const negotiate = useCallback(
    async (quality: string, mode: AudioMode): Promise<PlaybackInfo | null> => {
      const res = await apiFetch("/playback/info", {
        method: "POST",
        body: JSON.stringify({
          fileId,
          capabilities: WEB_CAPABILITIES,
          quality,
          audioMode: mode,
        }),
      });
      if (!res.ok) return null;
      return (await res.json()) as PlaybackInfo;
    },
    [fileId],
  );

  // Initial negotiation (source quality, standard audio) + saved progress, in
  // parallel on mount / retry.
  useEffect(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [data, progressRes] = await Promise.all([
          negotiate("source", "standard"),
          apiFetch(`/items/${mediaItemId}/progress${progressQuery}`),
        ]);
        if (!data) {
          setError(t("player:error.decision"));
          return;
        }
        infoRef.current = data;
        setInfo(data);
        setSelectedQuality(data.quality);
        setAudioMode(data.audioMode);
        if (progressRes.ok) setResume((await progressRes.json()) as Progress);
      } catch {
        setError(t("player:error.network"));
      } finally {
        setLoading(false);
      }
    })();
  }, [fileId, mediaItemId, progressQuery, t, negotiate, attempt]);

  // Drop a selected subtitle that the current session no longer offers (e.g.
  // after a re-negotiation returns a different track list).
  useEffect(() => {
    if (selectedSubtitle === "off") return;
    const tracks = info?.subtitleTracks ?? [];
    if (!tracks.some((s) => s.available && String(s.index) === selectedSubtitle)) {
      setSelectedSubtitle("off");
    }
  }, [selectedSubtitle, info]);

  // Save progress to the server (reads live state from the player ref); the
  // playSessionId rides along so the server can attribute the play event.
  const saveProgress = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return;
    const pos = player.state.currentTime;
    const dur = player.state.duration;
    if (dur <= 0) return;
    try {
      await apiFetch(`/items/${mediaItemId}/progress`, {
        method: "PUT",
        body: JSON.stringify({
          positionSec: pos,
          durationSec: dur,
          episodeId,
          playSessionId: infoRef.current?.playSessionId,
        }),
      });
    } catch {
      // Ignore transient save errors
    }
  }, [mediaItemId, episodeId]);

  // Periodic progress save (every 10s while playing)
  useEffect(() => {
    if (!info) return;
    const id = setInterval(async () => {
      const player = playerRef.current;
      if (!player || player.state.paused || player.state.duration <= 0) return;
      await saveProgress();
    }, SAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [info, saveProgress]);

  // Save progress on page hide (tab switch) and stop the play session (so its
  // ffmpeg + temp dir are released) on page hide / unmount.
  useEffect(() => {
    const stop = () => {
      const id = infoRef.current?.playSessionId;
      if (id) navigator.sendBeacon(`/api/playback/${id}/stop`);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") void saveProgress();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", stop);
      void saveProgress();
      stop();
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

  // Resume: seek to the pending position after a quality/audio switch remount,
  // otherwise seek to saved progress once when the player is first ready.
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

  // Re-negotiate for a new quality / audio mode. Remembers the current time so
  // the fresh session (a new streamUrl → key remount) resumes where we left
  // off, and releases the previous session's ffmpeg.
  const renegotiate = useCallback(
    async (quality: string, mode: AudioMode) => {
      rememberPlaybackTime();
      const prevId = infoRef.current?.playSessionId;
      const next = await negotiate(quality, mode);
      if (!next) {
        setError(t("player:error.decision"));
        return;
      }
      if (prevId && prevId !== next.playSessionId) {
        void apiFetch(`/playback/${prevId}/stop`, { method: "POST" }).catch(() => {});
      }
      infoRef.current = next;
      setInfo(next);
      setSelectedQuality(next.quality);
      setAudioMode(next.audioMode);
    },
    [negotiate, rememberPlaybackTime, t],
  );

  const handleQualityChange = (value: string) => {
    if (value === selectedQuality) return;
    void renegotiate(value, audioMode);
  };

  const handleAudioModeChange = (enabled: boolean) => {
    const next: AudioMode = enabled ? "leveled" : "standard";
    if (next === audioMode) return;
    void renegotiate(selectedQuality, next);
  };

  if (loading) {
    return (
      <div className="grid h-full w-full place-items-center text-sm text-[var(--text-dim)]">
        {t("player:loading")}
      </div>
    );
  }

  if (error || !info) {
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

  const textTracks = info.subtitleTracks.filter((s) => s.available);
  const selectedTrack =
    selectedSubtitle === "off"
      ? null
      : textTracks.find((track) => String(track.index) === selectedSubtitle) ?? null;
  const qualityOptions = info.qualities;
  const audioModes = info.audioModes;
  const audioLevelingAvailable = audioModes.some((mode) => mode.id === "leveled");

  return (
    <MediaPlayer
      key={`${info.streamUrl}#${attempt}`}
      ref={playerRef}
      title={title}
      src={{ src: info.streamUrl, type: info.mode === "direct" ? "video/mp4" : "application/x-mpegurl" }}
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
            value={selectedQuality}
            onChange={(event) => handleQualityChange(event.target.value)}
            className="max-w-32 rounded border border-white/15 bg-black/70 px-2 py-1 text-white outline-none transition-colors focus:border-[var(--accent)]"
          >
            {qualityOptions.map((quality) => (
              <option key={quality.id} value={quality.id}>
                {quality.label}
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
