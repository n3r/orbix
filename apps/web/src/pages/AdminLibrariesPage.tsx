import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { queryClient } from "@/lib/queryClient";
import type { Library, Source } from "@/lib/types";

interface ScanState {
  phase: string;
  processed?: number;
  total?: number;
  added?: number;
  updated?: number;
  skipped?: number;
  matched?: number;
  message?: string;
}

type SourceKind = "local" | "smb";
interface SourceDraft {
  kind: SourceKind;
  path: string;
  host: string;
  share: string;
  subpath: string;
  username: string;
  password: string;
  domain: string;
}
const emptyDraft: SourceDraft = { kind: "local", path: "", host: "", share: "", subpath: "", username: "", password: "", domain: "" };

export default function AdminLibrariesPage() {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [newLibName, setNewLibName] = useState("");
  const [libSaving, setLibSaving] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);

  // Add-source draft + state keyed by libraryId
  const [drafts, setDrafts] = useState<Record<string, SourceDraft>>({});
  const [sourceSaving, setSourceSaving] = useState<Record<string, boolean>>({});
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});

  // Scan state keyed by libraryId
  const [scanStates, setScanStates] = useState<Record<string, ScanState>>({});
  const [scanLoading, setScanLoading] = useState<Record<string, boolean>>({});
  const esRef = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    const sources = esRef.current;
    return () => { sources.forEach((es) => es.close()); sources.clear(); };
  }, []);

  async function loadLibraries() {
    try {
      const res = await apiFetch("/libraries");
      if (!res.ok) { setError(t("libraries:errors.loadFailed")); return; }
      setLibraries((await res.json()) as Library[]);
    } catch {
      setError(t("errors:network"));
    } finally {
      setLoading(false);
    }
  }

  // Reload local state AND invalidate the shared queries so dependent views
  // refresh: ["libraries"] for any library list, ["menu"] so the top-nav
  // catalog categories reflect added/removed libraries.
  async function refresh() {
    await loadLibraries();
    void queryClient.invalidateQueries({ queryKey: ["libraries"] });
    void queryClient.invalidateQueries({ queryKey: ["menu"] });
  }

  useEffect(() => { loadLibraries(); }, []);

  function draftFor(libraryId: string): SourceDraft {
    return drafts[libraryId] ?? emptyDraft;
  }
  function setDraft(libraryId: string, patch: Partial<SourceDraft>) {
    setDrafts((d) => ({ ...d, [libraryId]: { ...draftFor(libraryId), ...patch } }));
  }

  async function handleCreateLibrary(e: React.FormEvent) {
    e.preventDefault();
    setLibError(null);
    setLibSaving(true);
    try {
      const res = await apiFetch("/libraries", { method: "POST", body: JSON.stringify({ name: newLibName }) });
      if (res.ok) { setNewLibName(""); await refresh(); }
      else {
        const body = (await res.json()) as { error?: string };
        setLibError(body.error ? errorMessage(body.error, t) : t("libraries:errors.createFailed"));
      }
    } catch {
      setLibError(t("errors:network"));
    } finally {
      setLibSaving(false);
    }
  }

  async function handleDeleteLibrary(id: string) {
    await apiFetch(`/libraries/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function handleCreateSource(e: React.FormEvent, libraryId: string) {
    e.preventDefault();
    setSourceErrors((s) => ({ ...s, [libraryId]: "" }));
    setSourceSaving((s) => ({ ...s, [libraryId]: true }));
    const d = draftFor(libraryId);
    const body =
      d.kind === "local"
        ? { kind: "local", path: d.path }
        : { kind: "smb", host: d.host, share: d.share, subpath: d.subpath || undefined, username: d.username || undefined, password: d.password || undefined, domain: d.domain || undefined };
    try {
      const res = await apiFetch(`/libraries/${libraryId}/sources`, { method: "POST", body: JSON.stringify(body) });
      if (res.ok) { setDrafts((dd) => ({ ...dd, [libraryId]: emptyDraft })); await refresh(); }
      else {
        const b = (await res.json()) as { error?: string };
        setSourceErrors((s) => ({ ...s, [libraryId]: b.error ? errorMessage(b.error, t) : t("libraries:errors.addSourceFailed") }));
      }
    } catch {
      setSourceErrors((s) => ({ ...s, [libraryId]: t("errors:network") }));
    } finally {
      setSourceSaving((s) => ({ ...s, [libraryId]: false }));
    }
  }

  async function handleDeleteSource(id: string) {
    await apiFetch(`/sources/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function handleScan(libraryId: string) {
    setScanLoading((s) => ({ ...s, [libraryId]: true }));
    setScanStates((s) => ({ ...s, [libraryId]: { phase: t("libraries:scan.starting") } }));
    try {
      const res = await apiFetch(`/libraries/${libraryId}/scan`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        setScanStates((s) => ({ ...s, [libraryId]: { phase: b.error ? errorMessage(b.error, t) : t("libraries:scan.unknownError") } }));
        setScanLoading((s) => ({ ...s, [libraryId]: false }));
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      esRef.current.get(libraryId)?.close();
      const es = new EventSource(`/api/scan/${jobId}/stream`);
      esRef.current.set(libraryId, es);
      es.onmessage = (event: MessageEvent<string>) => {
        const data = JSON.parse(event.data) as ScanState;
        setScanStates((s) => ({ ...s, [libraryId]: data }));
        if (data.phase === "done" || data.phase === "error") {
          es.close();
          esRef.current.delete(libraryId);
          setScanLoading((s) => ({ ...s, [libraryId]: false }));
          if (data.phase === "done") void refresh();
        }
      };
      es.onerror = () => {
        setScanStates((s) => ({ ...s, [libraryId]: { phase: t("libraries:scan.streamError") } }));
        es.close();
        esRef.current.delete(libraryId);
        setScanLoading((s) => ({ ...s, [libraryId]: false }));
      };
    } catch {
      setScanStates((s) => ({ ...s, [libraryId]: { phase: t("libraries:scan.unknownError") } }));
      setScanLoading((s) => ({ ...s, [libraryId]: false }));
    }
  }

  function formatScanState(state: ScanState): string {
    if (state.phase === "done") {
      return t("libraries:scan.done", { count: state.added ?? 0, updated: state.updated ?? 0, matched: state.matched ?? 0 });
    }
    if (state.phase === "error") {
      return t("libraries:scan.failed", { message: state.message ?? t("libraries:scan.unknownError") });
    }
    if (state.processed !== undefined && state.total !== undefined) {
      const base = t("libraries:scan.progress", { phase: state.phase, processed: state.processed, total: state.total });
      return state.message ? `${base} — ${state.message}` : base;
    }
    return state.phase;
  }

  function sourceLabel(src: Source): string {
    return src.kind === "smb"
      ? `smb://${src.smbHost ?? "?"}/${src.smbShare ?? "?"}${src.smbSubpath ? "/" + src.smbSubpath : ""}`
      : src.path ?? "";
  }

  if (loading) {
    return <main className="p-8"><p className="text-[var(--text-dim)]">{t("common:status.loading")}</p></main>;
  }

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
     <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-[var(--text)]">{t("libraries:title")}</h1>
        <Link to="/account/settings" className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]">{t("libraries:settingsLink")}</Link>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Create Library */}
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("libraries:add.heading")}</h2>
        <form onSubmit={handleCreateLibrary} className="flex gap-2">
          <Input value={newLibName} onChange={(e) => setNewLibName(e.target.value)} placeholder={t("libraries:add.namePlaceholder")} required />
          <Button type="submit" disabled={libSaving}>{libSaving ? t("libraries:adding") : t("common:actions.add")}</Button>
        </form>
        {libError && <p className="mt-2 text-sm text-red-400">{libError}</p>}
      </Card>

      {/* Library list */}
      {libraries.map((lib) => {
        const d = draftFor(lib.id);
        return (
        <Card key={lib.id}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-[var(--text)]">{lib.name}</h2>
            <div className="flex gap-2 items-center">
              <Button onClick={() => handleScan(lib.id)} disabled={scanLoading[lib.id]}>
                {scanLoading[lib.id] ? t("libraries:scan.scanning") : t("libraries:scan.button")}
              </Button>
              <Button variant="ghost" onClick={() => handleDeleteLibrary(lib.id)}>{t("common:actions.delete")}</Button>
            </div>
          </div>

          {scanStates[lib.id] && (
            <p className="text-sm text-[var(--text-dim)] mb-3">{formatScanState(scanStates[lib.id]!)}</p>
          )}

          {lib.sources.length > 0 && (
            <ul className="mb-4 flex flex-col gap-1">
              {lib.sources.map((src) => (
                <li key={src.id} className="flex items-center justify-between text-sm text-[var(--text-dim)]">
                  <span className="font-mono truncate">
                    {sourceLabel(src)}
                    {src.status === "error" && <span className="ml-2 text-red-400">({t("libraries:source.errorLabel")}: {src.statusMessage})</span>}
                  </span>
                  <Button variant="ghost" onClick={() => handleDeleteSource(src.id)}>{t("common:actions.remove")}</Button>
                </li>
              ))}
            </ul>
          )}

          {/* Add source */}
          <form onSubmit={(e) => handleCreateSource(e, lib.id)} className="flex flex-col gap-2 border-t border-[var(--surface-2)] pt-3">
            <div className="flex gap-2">
              <select
                value={d.kind}
                onChange={(e) => setDraft(lib.id, { kind: e.target.value as SourceKind })}
                className="rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--surface)] px-2 text-[var(--text)]"
              >
                <option value="local">{t("libraries:source.kindLocal")}</option>
                <option value="smb">{t("libraries:source.kindSmb")}</option>
              </select>
              {d.kind === "local" ? (
                <Input value={d.path} onChange={(e) => setDraft(lib.id, { path: e.target.value })} placeholder={t("libraries:source.pathPlaceholder")} required />
              ) : (
                <Input value={d.host} onChange={(e) => setDraft(lib.id, { host: e.target.value })} placeholder={t("libraries:source.smbHostPlaceholder")} required />
              )}
              <Button type="submit" disabled={sourceSaving[lib.id]}>{sourceSaving[lib.id] ? t("libraries:adding") : t("libraries:source.addButton")}</Button>
            </div>
            {d.kind === "smb" && (
              <div className="grid grid-cols-2 gap-2">
                <Input value={d.share} onChange={(e) => setDraft(lib.id, { share: e.target.value })} placeholder={t("libraries:source.smbSharePlaceholder")} required />
                <Input value={d.subpath} onChange={(e) => setDraft(lib.id, { subpath: e.target.value })} placeholder={t("libraries:source.smbSubpathPlaceholder")} />
                <Input value={d.username} onChange={(e) => setDraft(lib.id, { username: e.target.value })} placeholder={t("libraries:source.smbUsernamePlaceholder")} />
                <Input type="password" value={d.password} onChange={(e) => setDraft(lib.id, { password: e.target.value })} placeholder={t("libraries:source.smbPasswordPlaceholder")} />
                <Input value={d.domain} onChange={(e) => setDraft(lib.id, { domain: e.target.value })} placeholder={t("libraries:source.smbDomainPlaceholder")} />
              </div>
            )}
          </form>
          {sourceErrors[lib.id] && <p className="mt-1 text-sm text-red-400">{sourceErrors[lib.id]}</p>}
        </Card>
        );
      })}
     </div>
    </main>
  );
}
