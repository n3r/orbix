import { useState, useEffect } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";

type EncoderValue = "software" | "vaapi" | "qsv" | "nvenc";

interface SettingsResponse {
  tmdbConfigured: boolean;
  encoder: EncoderValue;
  omdbConfigured: boolean;
  fanartConfigured: boolean;
  refreshCadenceDays: number;
}

const ENCODER_VALUES: EncoderValue[] = ["software", "vaapi", "qsv", "nvenc"];

export default function AdminSettingsPage() {
  const { t } = useTranslation();
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
        setError(t("settings:errors.loadFailed"));
        return;
      }
      const data = (await res.json()) as SettingsResponse;
      setTmdbConfigured(data.tmdbConfigured);
      setOmdbConfigured(data.omdbConfigured);
      setFanartConfigured(data.fanartConfigured);
      setEncoder(data.encoder ?? "software");
      setRefreshCadenceDays(data.refreshCadenceDays ?? 90);
    } catch {
      setError(t("errors:network"));
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
        setError(data.error ? errorMessage(data.error, t) : t("settings:errors.saveFailed"));
        return;
      }

      // Clear secret fields after successful save and refresh state
      setTmdbToken("");
      setOmdbKey("");
      setFanartKey("");
      setSuccess(true);
      await loadSettings();
    } catch {
      setError(t("errors:network"));
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
        setRebuildMsg(t("settings:maintenance.failed"));
        return;
      }
      const data = (await res.json()) as
        | { reason: "no_token" }
        | { rebuilt: number; unmatched: number; skipped: number };
      if ("reason" in data) {
        setRebuildMsg(t("settings:maintenance.noToken"));
      } else {
        const parts = [t("settings:maintenance.rebuiltCount", { count: data.rebuilt })];
        if (data.unmatched)
          parts.push(t("settings:maintenance.unmatchedCount", { count: data.unmatched }));
        if (data.skipped)
          parts.push(t("settings:maintenance.skippedCount", { count: data.skipped }));
        setRebuildMsg(parts.join(", ") + ".");
      }
    } catch {
      setRebuildMsg(t("settings:maintenance.networkError"));
    } finally {
      setRebuilding(false);
    }
  }

  if (loading) {
    return (
      <main className="p-8">
        <p className="text-[var(--text-dim)]">{t("common:status.loading")}</p>
      </main>
    );
  }

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
     <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-[var(--text)]">{t("settings:title")}</h1>
        <Link
          to="/admin/libraries"
          className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          {t("settings:backToLibraries")}
        </Link>
      </div>

      <form onSubmit={handleSave} className="flex flex-col gap-6">
        {/* Metadata providers */}
        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("settings:providers.heading")}</h2>

          <div className="flex flex-col gap-4">
            {/* TMDB */}
            <div>
              <label className="block mb-1 text-sm font-medium text-[var(--text)]">
                {t("settings:providers.tmdb.label")}
              </label>
              <p className="mb-2 text-xs text-[var(--text-dim)]">
                {t("settings:providers.statusLabel")}{" "}
                <span className={tmdbConfigured ? "text-green-400" : "text-yellow-400"}>
                  {tmdbConfigured ? t("settings:providers.status.configured") : t("settings:providers.status.notConfigured")}
                </span>
              </p>
              <Input
                type="password"
                value={tmdbToken}
                onChange={(e) => setTmdbToken(e.target.value)}
                placeholder={tmdbConfigured ? t("settings:providers.tmdb.placeholderConfigured") : t("settings:providers.tmdb.placeholderEmpty")}
                autoComplete="off"
              />
            </div>

            {/* OMDb */}
            <div>
              <label className="block mb-1 text-sm font-medium text-[var(--text)]">
                {t("settings:providers.omdb.label")}{" "}
                <span className="text-[var(--text-dim)] font-normal">{t("settings:providers.optional")}</span>
              </label>
              <p className="mb-2 text-xs text-[var(--text-dim)]">
                {t("settings:providers.statusLabel")}{" "}
                <span className={omdbConfigured ? "text-green-400" : "text-[var(--text-dim)]"}>
                  {omdbConfigured ? t("settings:providers.status.configured") : t("settings:providers.status.notSet")}
                </span>
              </p>
              <Input
                type="password"
                value={omdbKey}
                onChange={(e) => setOmdbKey(e.target.value)}
                placeholder={omdbConfigured ? t("settings:providers.placeholderKeyConfigured") : t("settings:providers.placeholderKeyEmpty")}
                autoComplete="off"
              />
            </div>

            {/* Fanart.tv */}
            <div>
              <label className="block mb-1 text-sm font-medium text-[var(--text)]">
                {t("settings:providers.fanart.label")}{" "}
                <span className="text-[var(--text-dim)] font-normal">{t("settings:providers.optional")}</span>
              </label>
              <p className="mb-2 text-xs text-[var(--text-dim)]">
                {t("settings:providers.statusLabel")}{" "}
                <span className={fanartConfigured ? "text-green-400" : "text-[var(--text-dim)]"}>
                  {fanartConfigured ? t("settings:providers.status.configured") : t("settings:providers.status.notSet")}
                </span>
              </p>
              <Input
                type="password"
                value={fanartKey}
                onChange={(e) => setFanartKey(e.target.value)}
                placeholder={fanartConfigured ? t("settings:providers.placeholderKeyConfigured") : t("settings:providers.placeholderKeyEmpty")}
                autoComplete="off"
              />
            </div>
          </div>
        </Card>

        {/* Transcode settings */}
        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("settings:transcode.heading")}</h2>

          <div>
            <label className="block mb-1 text-sm font-medium text-[var(--text)]">
              {t("settings:transcode.encoderLabel")}
            </label>
            <p className="mb-2 text-xs text-[var(--text-dim)]">
              {t("settings:transcode.encoderHelp")}
            </p>
            <select
              value={encoder}
              onChange={(e) => setEncoder(e.target.value as EncoderValue)}
              className="w-full rounded border border-[var(--border,#333)] bg-[var(--surface,#1a1a1a)] px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent,#6366f1)]"
            >
              {ENCODER_VALUES.map((val) => (
                <option key={val} value={val}>
                  {t(`settings:transcode.encoders.${val}`)}
                </option>
              ))}
            </select>
          </div>
        </Card>

        {/* Library refresh */}
        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("settings:library.heading")}</h2>

          <div>
            <label className="block mb-1 text-sm font-medium text-[var(--text)]">
              {t("settings:library.cadenceLabel")}
            </label>
            <p className="mb-2 text-xs text-[var(--text-dim)]">
              {t("settings:library.cadenceHelp")}
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
        {success && <p className="text-sm text-green-400">{t("settings:saveSuccess")}</p>}

        <Button type="submit" disabled={saving}>
          {saving ? t("common:status.saving") : t("settings:saveButton")}
        </Button>
      </form>

      {/* Maintenance — re-enrich the whole library on demand */}
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("settings:maintenance.heading")}</h2>
        <p className="mb-3 text-xs text-[var(--text-dim)]">
          {t("settings:maintenance.help")}
        </p>
        <Button type="button" variant="ghost" onClick={handleRebuild} disabled={rebuilding}>
          {rebuilding ? t("settings:maintenance.rebuilding") : t("settings:maintenance.rebuildButton")}
        </Button>
        {rebuildMsg && <p className="mt-3 text-sm text-[var(--text-dim)]">{rebuildMsg}</p>}
      </Card>

     </div>
    </main>
  );
}
