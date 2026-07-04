import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Card, Input, cn } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import type { TvSource } from "@/lib/types";
import { regionName } from "@/lib/tv";

/** iptv-org country codes offered as checkboxes (their codes — UK, not GB). */
const TV_COUNTRIES = [
  "RU", "UK", "US", "DE", "FR", "ES", "PT", "IT", "NL", "BE", "CH", "AT",
  "PL", "CZ", "SK", "HU", "RO", "BG", "RS", "GR", "TR", "UA", "BY", "KZ",
  "SE", "NO", "FI", "DK", "BR", "MX", "AR", "CA",
] as const;

const MAX_M3U_FILE_BYTES = 5 * 1024 * 1024;

interface SyncState {
  phase: string;
  processed?: number;
  total?: number;
  message?: string;
}

/**
 * Admin TV sources: the iptv-org worldwide catalog (opt-in, country-scoped)
 * and user M3U playlists, with per-source sync + SSE progress — the
 * AdminLibrariesPage scan idiom applied to the tv-sync queue. `?wizard=1`
 * renders the same primitives as a 3-step first-run stepper.
 */
export default function AccountTvPage() {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const wizard = searchParams.get("wizard") === "1";
  const [wizardStep, setWizardStep] = useState(0);

  const [sources, setSources] = useState<TvSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [m3uName, setM3uName] = useState("");
  const [m3uUrl, setM3uUrl] = useState("");
  const [m3uError, setM3uError] = useState<string | null>(null);
  const [m3uSaving, setM3uSaving] = useState(false);

  const [countryDraft, setCountryDraft] = useState("");
  // Countries picked before the iptv-org source exists yet — the API requires
  // a non-empty `countries` array (and a name) on create, so there is no
  // "create empty, fill in later" path. This holds the pending selection
  // until the first create (Enable button / wizard Next).
  const [draftCountries, setDraftCountries] = useState<string[]>([]);
  const [iptvSaving, setIptvSaving] = useState(false);

  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({});
  const [syncLoading, setSyncLoading] = useState<Record<string, boolean>>({});
  const esRef = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    const streams = esRef.current;
    return () => {
      streams.forEach((es) => es.close());
      streams.clear();
    };
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(): Promise<TvSource[]> {
    try {
      const res = await apiFetch("/tv/sources");
      if (!res.ok) {
        setError(t("tv:admin.loadFailed"));
        return [];
      }
      const list = (await res.json()) as TvSource[];
      setSources(list);
      setError(null);
      return list;
    } catch {
      setError(t("errors:network"));
      return [];
    } finally {
      setLoading(false);
    }
  }

  const iptv = sources.find((s) => s.kind === "iptv-org") ?? null;
  const m3uSources = sources.filter((s) => s.kind === "m3u");
  // What the country picker shows: the real source's countries once it
  // exists, otherwise the not-yet-saved local selection.
  const activeCountries = iptv?.countries ?? draftCountries;

  /**
   * The single iptv-org row — created on first use (max one, per spec).
   * The API 400s a `kind:"iptv-org"` create with no name or an empty
   * `countries` array, so this always sends a name and requires >=1 country;
   * callers (Enable button, wizard Next) keep themselves disabled until
   * `draftCountries` is non-empty.
   */
  async function ensureIptv(countries: string[]): Promise<TvSource | null> {
    if (iptv) return iptv;
    if (countries.length === 0) return null;
    setIptvSaving(true);
    try {
      const res = await apiFetch("/tv/sources", {
        method: "POST",
        body: JSON.stringify({ kind: "iptv-org", name: t("tv:admin.iptv.heading"), countries }),
      });
      if (!res.ok) {
        setError(t("tv:admin.saveFailed"));
        return null;
      }
      const list = await load();
      return list.find((s) => s.kind === "iptv-org") ?? null;
    } finally {
      setIptvSaving(false);
    }
  }

  async function patchSource(id: string, patch: Record<string, unknown>) {
    const res = await apiFetch(`/tv/sources/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (!res.ok) setError(t("tv:admin.saveFailed"));
    await load();
  }

  async function toggleCountry(code: string) {
    if (!iptv) {
      // Not created yet — just track the pending selection locally.
      setDraftCountries((d) => (d.includes(code) ? d.filter((c) => c !== code) : [...d, code]));
      return;
    }
    const next = iptv.countries.includes(code)
      ? iptv.countries.filter((c) => c !== code)
      : [...iptv.countries, code];
    // Belt-and-suspenders: the last checkbox is disabled (see countryPicker)
    // so this shouldn't fire with an empty result, but never PATCH it anyway.
    if (next.length === 0) return;
    await patchSource(iptv.id, { countries: next });
  }

  async function addCountry() {
    const code = countryDraft.trim().toUpperCase();
    setCountryDraft("");
    if (!code) return;
    if (!iptv) {
      setDraftCountries((d) => (d.includes(code) ? d : [...d, code]));
      return;
    }
    if (iptv.countries.includes(code)) return;
    await patchSource(iptv.id, { countries: [...iptv.countries, code] });
  }

  async function deleteSource(id: string) {
    await apiFetch(`/tv/sources/${id}`, { method: "DELETE" });
    await load();
  }

  async function addM3uByUrl(e: React.FormEvent) {
    e.preventDefault();
    setM3uError(null);
    setM3uSaving(true);
    try {
      const res = await apiFetch("/tv/sources", {
        method: "POST",
        body: JSON.stringify({ kind: "m3u", name: m3uName || m3uUrl, url: m3uUrl }),
      });
      if (!res.ok) {
        setM3uError(t("tv:admin.saveFailed"));
        return;
      }
      setM3uName("");
      setM3uUrl("");
      await load();
    } catch {
      setM3uError(t("errors:network"));
    } finally {
      setM3uSaving(false);
    }
  }

  function addM3uFile(file: File) {
    setM3uError(null);
    if (file.size > MAX_M3U_FILE_BYTES) {
      setM3uError(t("tv:admin.m3u.fileTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        try {
          const res = await apiFetch("/tv/sources", {
            method: "POST",
            body: JSON.stringify({
              kind: "m3u",
              name: m3uName || file.name,
              fileContent: String(reader.result ?? ""),
            }),
          });
          if (!res.ok) {
            setM3uError(t("tv:admin.saveFailed"));
            return;
          }
          setM3uName("");
          await load();
        } catch {
          setM3uError(t("errors:network"));
        }
      })();
    };
    reader.readAsText(file);
  }

  async function syncNow(id: string) {
    setSyncLoading((s) => ({ ...s, [id]: true }));
    setSyncStates((s) => ({ ...s, [id]: { phase: t("tv:admin.source.syncing") } }));
    try {
      const res = await apiFetch(`/tv/sources/${id}/sync`, { method: "POST" });
      if (!res.ok) {
        setSyncStates((s) => ({ ...s, [id]: { phase: t("tv:admin.sync.error", { message: String(res.status) }) } }));
        setSyncLoading((s) => ({ ...s, [id]: false }));
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      esRef.current.get(id)?.close();
      const es = new EventSource(`/api/tv/sync/events?jobId=${jobId}`);
      esRef.current.set(id, es);
      es.onmessage = (event: MessageEvent<string>) => {
        const data = JSON.parse(event.data) as SyncState;
        setSyncStates((s) => ({ ...s, [id]: data }));
        if (data.phase === "done" || data.phase === "error") {
          es.close();
          esRef.current.delete(id);
          setSyncLoading((s) => ({ ...s, [id]: false }));
          if (data.phase === "done") void load();
        }
      };
      es.onerror = () => {
        setSyncStates((s) => ({ ...s, [id]: { phase: t("tv:admin.sync.streamError") } }));
        es.close();
        esRef.current.delete(id);
        setSyncLoading((s) => ({ ...s, [id]: false }));
      };
    } catch {
      setSyncStates((s) => ({ ...s, [id]: { phase: t("errors:network") } }));
      setSyncLoading((s) => ({ ...s, [id]: false }));
    }
  }

  function syncLine(state: SyncState | undefined): string | null {
    if (!state) return null;
    if (state.phase === "done") return t("tv:admin.sync.done");
    if (state.phase === "error") return t("tv:admin.sync.error", { message: state.message ?? "" });
    if (state.processed !== undefined && state.total !== undefined) {
      return t("tv:admin.sync.progress", { phase: state.phase, processed: state.processed, total: state.total });
    }
    return state.phase;
  }

  const countryPicker = (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-[var(--text)]">{t("tv:admin.iptv.countries")}</p>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
        {TV_COUNTRIES.map((code) => {
          const checked = activeCountries.includes(code);
          // Once the source exists, block unchecking the last remaining
          // country client-side — the API 400s countries:[] on PATCH.
          const lastOne = iptv != null && checked && activeCountries.length === 1;
          return (
            <label
              key={code}
              className={cn(
                "flex items-center gap-2 rounded px-1.5 py-1 text-sm text-[var(--text-dim)] hover:bg-[var(--surface-2)]",
                lastOne && "opacity-60",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={lastOne}
                onChange={() => void toggleCountry(code)}
              />
              <span className="truncate">{regionName(code, i18n.language) ?? code}</span>
            </label>
          );
        })}
      </div>
      {activeCountries.some((c) => !(TV_COUNTRIES as readonly string[]).includes(c)) && (
        <p className="text-xs text-[var(--text-dim)]">
          + {activeCountries.filter((c) => !(TV_COUNTRIES as readonly string[]).includes(c)).join(", ")}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void addCountry();
        }}
        className="flex gap-2"
      >
        <Input
          value={countryDraft}
          onChange={(e) => setCountryDraft(e.target.value)}
          placeholder={t("tv:admin.iptv.addCountryPlaceholder")}
        />
        <Button type="submit" variant="ghost">
          {t("tv:admin.iptv.addCountry")}
        </Button>
      </form>
    </div>
  );

  const m3uAdd = (
    <div className="flex flex-col gap-2">
      <form onSubmit={(e) => void addM3uByUrl(e)} className="flex flex-col gap-2 sm:flex-row">
        <Input value={m3uName} onChange={(e) => setM3uName(e.target.value)} placeholder={t("tv:admin.m3u.namePlaceholder")} />
        <Input value={m3uUrl} onChange={(e) => setM3uUrl(e.target.value)} placeholder={t("tv:admin.m3u.urlPlaceholder")} required />
        <Button type="submit" disabled={m3uSaving}>{t("tv:admin.m3u.addByUrl")}</Button>
      </form>
      <label className="text-xs text-[var(--text-dim)]">
        {t("tv:admin.m3u.orFile")}{" "}
        <input
          type="file"
          accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) addM3uFile(file);
            e.target.value = "";
          }}
          className="text-xs"
        />
      </label>
      {m3uError && <p className="text-sm text-red-400">{m3uError}</p>}
    </div>
  );

  const sourceRow = (s: TvSource) => (
    <div key={s.id} className="flex flex-col gap-1 border-t border-[var(--surface-2)] py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text)]">{s.name}</span>
          <span className="block truncate text-xs text-[var(--text-dim)]">
            {t("tv:admin.source.lastSync", {
              when: s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(i18n.language) : t("tv:admin.source.never"),
            })}
            {s.status === "error" && s.statusMessage && (
              <span className="text-red-400"> — {s.statusMessage}</span>
            )}
          </span>
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-dim)]">
          <input type="checkbox" checked={s.enabled} onChange={() => void patchSource(s.id, { enabled: !s.enabled })} />
          {t("tv:admin.source.enabled")}
        </label>
        <Button variant="ghost" onClick={() => void syncNow(s.id)} disabled={syncLoading[s.id]}>
          {syncLoading[s.id] ? t("tv:admin.source.syncing") : t("tv:admin.source.syncNow")}
        </Button>
        <Button variant="ghost" onClick={() => void deleteSource(s.id)}>
          {t("common:actions.delete")}
        </Button>
      </div>
      {syncLine(syncStates[s.id]) && (
        <p className="text-xs text-[var(--text-dim)]">{syncLine(syncStates[s.id])}</p>
      )}
    </div>
  );

  if (loading) {
    return (
      <main className="p-8">
        <p className="text-[var(--text-dim)]">{t("common:status.loading")}</p>
      </main>
    );
  }

  if (wizard) {
    return (
      <main className="flex flex-col gap-6">
        <h2 className="text-2xl font-bold text-[var(--text)]">{t("tv:wizard.title")}</h2>
        {error && <p className="text-sm text-red-400">{error}</p>}

        <Card>
          {wizardStep === 0 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-semibold text-[var(--text)]">{t("tv:wizard.stepCountries")}</h3>
              {countryPicker}
              <div className="flex justify-end">
                <Button
                  onClick={() =>
                    void (async () => {
                      if (!(await ensureIptv(draftCountries))) return;
                      setWizardStep(1);
                    })()
                  }
                  disabled={(!iptv && draftCountries.length === 0) || iptvSaving}
                >
                  {t("tv:wizard.next")}
                </Button>
              </div>
            </div>
          )}
          {wizardStep === 1 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-semibold text-[var(--text)]">{t("tv:wizard.stepM3u")}</h3>
              {m3uAdd}
              {m3uSources.length > 0 && <div>{m3uSources.map(sourceRow)}</div>}
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => setWizardStep(0)}>{t("common:actions.back")}</Button>
                <Button onClick={() => setWizardStep(2)}>
                  {m3uSources.length > 0 ? t("tv:wizard.next") : t("tv:wizard.skip")}
                </Button>
              </div>
            </div>
          )}
          {wizardStep === 2 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-semibold text-[var(--text)]">{t("tv:wizard.stepSummary")}</h3>
              <p className="text-sm text-[var(--text-dim)]">
                {t("tv:wizard.summary", { countries: iptv?.countries.length ?? 0, sources: m3uSources.length })}
              </p>
              <div>{sources.map(sourceRow)}</div>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => setWizardStep(1)}>{t("common:actions.back")}</Button>
                <Link to="/tv">
                  <Button>{t("tv:wizard.finish")}</Button>
                </Link>
              </div>
            </div>
          )}
        </Card>

        <p className="text-xs text-[var(--text-dim)]">{t("tv:admin.legal")}</p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold text-[var(--text)]">{t("tv:admin.title")}</h2>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <h3 className="mb-1 text-lg font-semibold text-[var(--text)]">{t("tv:admin.iptv.heading")}</h3>
        <p className="mb-4 text-xs text-[var(--text-dim)]">{t("tv:admin.iptv.description")}</p>
        <div className="flex flex-col gap-4">
          {countryPicker}
          {iptv ? (
            sourceRow(iptv)
          ) : (
            <Button onClick={() => void ensureIptv(draftCountries)} disabled={draftCountries.length === 0 || iptvSaving}>
              {t("tv:admin.iptv.enable")}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("tv:admin.m3u.heading")}</h3>
        {m3uSources.length === 0 ? (
          <p className="mb-3 text-sm text-[var(--text-dim)]">{t("tv:admin.m3u.empty")}</p>
        ) : (
          <div className="mb-3">{m3uSources.map(sourceRow)}</div>
        )}
        {m3uAdd}
      </Card>

      <p className="text-xs text-[var(--text-dim)]">{t("tv:admin.legal")}</p>
    </main>
  );
}
