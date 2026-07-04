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
import { apiFetch } from "@/lib/api";

interface PlaybackInfo {
  playSessionId: string;
  mode: string;
  streamUrl: string;
  audioTracks: { index: number; codec?: string; channels?: number; language?: string; selected: boolean }[];
  subtitleTracks: { index: number; codec?: string; language?: string; available: boolean; reason?: string }[];
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const playerRef = useRef<MediaPlayerInstance>(null);
  const resumedRef = useRef(false);
  const infoRef = useRef<PlaybackInfo | null>(null);

  // Negotiate playback (mode + stream URL + track lists) via PlaybackInfo, and
  // fetch saved progress, in parallel on mount.
  useEffect(() => {
    void (async () => {
      try {
        const [infoRes, progressRes] = await Promise.all([
          apiFetch("/playback/info", {
            method: "POST",
            body: JSON.stringify({ fileId, capabilities: WEB_CAPABILITIES }),
          }),
          apiFetch(`/items/${mediaItemId}/progress${progressQuery}`),
        ]);
        if (!infoRes.ok) {
          setError(t("player:error.decision"));
          return;
        }
        const data = (await infoRes.json()) as PlaybackInfo;
        infoRef.current = data;
        setInfo(data);
        if (progressRes.ok) setResume((await progressRes.json()) as Progress);
      } catch {
        setError(t("player:error.network"));
      } finally {
        setLoading(false);
      }
    })();
  }, [fileId, mediaItemId, progressQuery, t]);

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

  // Resume: seek to saved position when the player is ready
  const handleCanPlay = useCallback(() => {
    if (resumedRef.current) return;
    if (!resume || resume.positionSec <= 0 || resume.finished) return;
    resumedRef.current = true;
    playerRef.current?.remoteControl.seek(resume.positionSec);
  }, [resume]);

  // Save progress when the user pauses
  const handlePause = useCallback(() => {
    void saveProgress();
  }, [saveProgress]);

  if (loading) {
    return (
      <div className="grid h-full w-full place-items-center text-sm text-[var(--text-dim)]">
        {t("player:loading")}
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="grid h-full w-full place-items-center text-sm text-red-400">
        {error ?? t("player:error.generic")}
      </div>
    );
  }

  const textTracks = info.subtitleTracks.filter((s) => s.available);

  return (
    <MediaPlayer
      ref={playerRef}
      title={title}
      src={{ src: info.streamUrl, type: info.mode === "direct" ? "video/mp4" : "application/x-mpegurl" }}
      className="h-full w-full bg-black"
      style={{ "--media-brand": "var(--accent)" }}
      autoPlay
      playsInline
      keyTarget="document"
      onProviderChange={onProviderChange}
      onCanPlay={handleCanPlay}
      onPause={handlePause}
    >
      <MediaProvider>
        {textTracks.map((track) => (
          <Track
            key={String(track.index)}
            src={`/api/play/${fileId}/subs/${track.index}.vtt`}
            kind="subtitles"
            label={track.language ?? t("player:track.label", { index: track.index })}
            language={track.language ?? ""}
          />
        ))}
      </MediaProvider>
      <DefaultVideoLayout
        icons={defaultLayoutIcons}
        colorScheme="dark"
        seekStep={10}
        slots={{ largeLayout: { beforePlayButton: seekBackward10, afterPlayButton: seekForward30 } }}
      />
    </MediaPlayer>
  );
}
