"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { MediaPlayer, MediaProvider, Track, isHLSProvider, type MediaPlayerInstance, type MediaProviderAdapter } from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import Hls from "hls.js";
import { apiFetch } from "@/lib/api";

interface Decision {
  mode: string;
  url: string;
}

interface SubTrack {
  index: number;
  codec: string;
  language?: string;
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
}

const SAVE_INTERVAL_MS = 10_000;

export default function Player({ fileId, mediaItemId, title }: Props) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [subs, setSubs] = useState<SubTrack[]>([]);
  const [resume, setResume] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const playerRef = useRef<MediaPlayerInstance>(null);
  const resumedRef = useRef(false);

  // Fetch decision, subtitle tracks, and saved progress on mount
  useEffect(() => {
    void (async () => {
      try {
        const [decisionRes, subsRes, progressRes] = await Promise.all([
          apiFetch(`/play/${fileId}/decision`),
          apiFetch(`/play/${fileId}/subs`),
          apiFetch(`/items/${mediaItemId}/progress`),
        ]);

        if (!decisionRes.ok) {
          setError("Could not get playback decision");
          return;
        }
        const d = (await decisionRes.json()) as Decision;
        setDecision(d);

        if (subsRes.ok) {
          const s = (await subsRes.json()) as SubTrack[];
          setSubs(s);
        }

        if (progressRes.ok) {
          const p = (await progressRes.json()) as Progress;
          setResume(p);
        }
      } catch {
        setError("Network error loading player");
      } finally {
        setLoading(false);
      }
    })();
  }, [fileId, mediaItemId]);

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
        body: JSON.stringify({ positionSec: pos, durationSec: dur }),
      });
    } catch {
      // Ignore transient save errors
    }
  }, [mediaItemId]);

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
      <p className="text-sm text-[var(--text-dim)] py-2">Loading player…</p>
    );
  }

  if (error || !decision) {
    return (
      <p className="text-sm text-red-400 py-2">{error ?? "Failed to load player"}</p>
    );
  }

  const textTracks = subs.filter((s) => !s.burnIn);

  return (
    <MediaPlayer
      ref={playerRef}
      title={title}
      src={{ src: decision.url, type: decision.mode === "direct" ? "video/mp4" : "application/x-mpegurl" }}
      className="w-full aspect-video bg-black rounded-[var(--radius)] overflow-hidden"
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
            label={track.language ?? `Track ${track.index}`}
            language={track.language ?? ""}
          />
        ))}
      </MediaProvider>
      <DefaultVideoLayout icons={defaultLayoutIcons} />
    </MediaPlayer>
  );
}
