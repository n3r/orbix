"use client";

import { useState, useEffect } from "react";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

type EncoderValue = "software" | "vaapi" | "qsv" | "nvenc";

interface SettingsResponse {
  tmdbConfigured: boolean;
  encoder: EncoderValue;
  omdbConfigured: boolean;
  fanartConfigured: boolean;
  refreshCadenceDays: number;
}

const ENCODER_LABELS: Record<EncoderValue, string> = {
  software: "Software (libx264)",
  vaapi: "VA-API (h264_vaapi)",
  qsv: "Intel QSV (h264_qsv)",
  nvenc: "NVIDIA NVENC (h264_nvenc)",
};

export default function AdminSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Current state from server
  const [tmdbConfigured, setTmdbConfigured] = useState(false);
  const [omdbConfigured, setOmdbConfigured] = useState(false);
  const [fanartConfigured, setFanartConfigured] = useState(false);

  // Form fields (secrets are write-only; show placeholder when configured)
  const [tmdbToken, setTmdbToken] = useState("");
  const [encoder, setEncoder] = useState<EncoderValue>("software");
  const [omdbKey, setOmdbKey] = useState("");
  const [fanartKey, setFanartKey] = useState("");
  const [refreshCadenceDays, setRefreshCadenceDays] = useState(90);

  // Rebuild-metadata action (independent of the settings form)
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const res = await apiFetch("/settings");
      if (!res.ok) {
        setError("Failed to load settings");
        return;
      }
      const data = (await res.json()) as SettingsResponse;
      setTmdbConfigured(data.tmdbConfigured);
      setOmdbConfigured(data.omdbConfigured);
      setFanartConfigured(data.fanartConfigured);
      setEncoder(data.encoder ?? "software");
      setRefreshCadenceDays(data.refreshCadenceDays ?? 90);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);

    try {
      const body: Record<string, unknown> = { encoder, refreshCadenceDays };
      if (tmdbToken) body.tmdbToken = tmdbToken;
      if (omdbKey) body.omdbKey = omdbKey;
      if (fanartKey) body.fanartKey = fanartKey;

      const res = await apiFetch("/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Failed to save settings");
        return;
      }

      // Clear secret fields after successful save and refresh state
      setTmdbToken("");
      setOmdbKey("");
      setFanartKey("");
      setSuccess(true);
      await loadSettings();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleRebuild() {
    setRebuilding(true);
    setRebuildMsg(null);
    try {
      const res = await apiFetch("/maintenance/rebuild", { method: "POST" });
      if (!res.ok) {
        setRebuildMsg("Rebuild failed — check the server logs.");
        return;
      }
      const data = (await res.json()) as
        | { reason: "no_token" }
        | { rebuilt: number; unmatched: number; skipped: number };
      if ("reason" in data) {
        setRebuildMsg("Add a TMDB API token above and click Save Settings before rebuilding.");
      } else {
        setRebuildMsg(
          `Rebuilt ${data.rebuilt} title${data.rebuilt === 1 ? "" : "s"}` +
            (data.unmatched ? `, ${data.unmatched} with no TMDB match` : "") +
            (data.skipped ? `, ${data.skipped} errored` : "") +
            ".",
        );
      }
    } catch {
      setRebuildMsg("Network error during rebuild.");
    } finally {
      setRebuilding(false);
    }
  }

  if (loading) {
    return (
      <main className="p-8">
        <p className="text-[var(--text-dim)]">Loading...</p>
      </main>
    );
  }

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
     <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-[var(--text)]">Settings</h1>
        <a
          href="/admin/libraries"
          className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          Back to Libraries
        </a>
      </div>

      <form onSubmit={handleSave} className="flex flex-col gap-6">
        {/* Metadata providers */}
        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Metadata Providers</h2>

          <div className="flex flex-col gap-4">
            {/* TMDB */}
            <div>
              <label className="block mb-1 text-sm font-medium text-[var(--text)]">
                TMDB API Token
              </label>
              <p className="mb-2 text-xs text-[var(--text-dim)]">
                Status:{" "}
                <span className={tmdbConfigured ? "text-green-400" : "text-yellow-400"}>
                  {tmdbConfigured ? "configured" : "not configured"}
                </span>
              </p>
              <Input
                type="password"
                value={tmdbToken}
                onChange={(e) => setTmdbToken(e.target.value)}
                placeholder={tmdbConfigured ? "Leave blank to keep existing token" : "Paste token to configure"}
                autoComplete="off"
              />
            </div>

            {/* OMDb */}
            <div>
              <label className="block mb-1 text-sm font-medium text-[var(--text)]">
                OMDb API Key{" "}
                <span className="text-[var(--text-dim)] font-normal">(optional)</span>
              </label>
              <p className="mb-2 text-xs text-[var(--text-dim)]">
                Status:{" "}
                <span className={omdbConfigured ? "text-green-400" : "text-[var(--text-dim)]"}>
                  {omdbConfigured ? "configured" : "not set"}
                </span>
              </p>
              <Input
                type="password"
                value={omdbKey}
                onChange={(e) => setOmdbKey(e.target.value)}
                placeholder={omdbConfigured ? "Leave blank to keep existing key" : "Paste key to configure"}
                autoComplete="off"
              />
            </div>

            {/* Fanart.tv */}
            <div>
              <label className="block mb-1 text-sm font-medium text-[var(--text)]">
                Fanart.tv API Key{" "}
                <span className="text-[var(--text-dim)] font-normal">(optional)</span>
              </label>
              <p className="mb-2 text-xs text-[var(--text-dim)]">
                Status:{" "}
                <span className={fanartConfigured ? "text-green-400" : "text-[var(--text-dim)]"}>
                  {fanartConfigured ? "configured" : "not set"}
                </span>
              </p>
              <Input
                type="password"
                value={fanartKey}
                onChange={(e) => setFanartKey(e.target.value)}
                placeholder={fanartConfigured ? "Leave blank to keep existing key" : "Paste key to configure"}
                autoComplete="off"
              />
            </div>
          </div>
        </Card>

        {/* Transcode settings */}
        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Transcoding</h2>

          <div>
            <label className="block mb-1 text-sm font-medium text-[var(--text)]">
              Video Encoder
            </label>
            <p className="mb-2 text-xs text-[var(--text-dim)]">
              Choose the hardware or software encoder used when transcoding. Software (libx264) always works; hardware encoders require the corresponding GPU driver/VAAPI/NVENC support on the server.
            </p>
            <select
              value={encoder}
              onChange={(e) => setEncoder(e.target.value as EncoderValue)}
              className="w-full rounded border border-[var(--border,#333)] bg-[var(--surface,#1a1a1a)] px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent,#6366f1)]"
            >
              {(Object.entries(ENCODER_LABELS) as [EncoderValue, string][]).map(([val, label]) => (
                <option key={val} value={val}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </Card>

        {/* Library refresh */}
        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Library</h2>

          <div>
            <label className="block mb-1 text-sm font-medium text-[var(--text)]">
              Metadata Refresh Cadence (days)
            </label>
            <p className="mb-2 text-xs text-[var(--text-dim)]">
              How many days between automatic metadata refreshes. Set higher to reduce API calls.
            </p>
            <Input
              type="number"
              min={1}
              value={refreshCadenceDays}
              onChange={(e) => setRefreshCadenceDays(Number(e.target.value))}
            />
          </div>
        </Card>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {success && <p className="text-sm text-green-400">Settings saved.</p>}

        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </form>

      {/* Maintenance — re-enrich the whole library on demand */}
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Maintenance</h2>
        <p className="mb-3 text-xs text-[var(--text-dim)]">
          Re-fetch metadata and artwork for every title from TMDB now. Use this
          after adding or changing your TMDB token. Titles you fixed manually keep
          their chosen poster. Large libraries may take a while.
        </p>
        <Button type="button" variant="ghost" onClick={handleRebuild} disabled={rebuilding}>
          {rebuilding ? "Rebuilding…" : "Rebuild metadata"}
        </Button>
        {rebuildMsg && <p className="mt-3 text-sm text-[var(--text-dim)]">{rebuildMsg}</p>}
      </Card>

     </div>
    </main>
  );
}
