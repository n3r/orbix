import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Card, ConfirmDialog, Input, Skeleton } from "@orbix/ui";
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

  // Confirm gate for irreversible deletes (a library takes all its items with it).
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "library" | "source"; id: string; name: string } | null
  >(null);
  const [deleting, setDeleting] = useState(false);

  const [newLibName, setNewLibName] = useState("");
  const [libSaving, setLibSaving] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);

  const [editingLibraryId, setEditingLibraryId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameSaving, setRenameSaving] = useState<string | null>(null);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [expandedLibraryId, setExpandedLibraryId] = useState<string | null>(null);

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

  function isTerminalScan(state: ScanState | null | undefined): boolean {
    return state?.phase === "done" || state?.phase === "error";
  }

  function attachScanStream(libraryId: string, jobId: string) {
    if (esRef.current.has(libraryId)) return;
    setScanLoading((s) => ({ ...s, [libraryId]: true }));
    const es = new EventSource(`/api/scan/${jobId}/stream`);
    esRef.current.set(libraryId, es);
    es.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as ScanState;
      setScanStates((s) => ({ ...s, [libraryId]: data }));
      if (isTerminalScan(data)) {
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
  }

  async function loadLibraries() {
    try {
      const res = await apiFetch("/libraries");
      if (!res.ok) { setError(t("libraries:errors.loadFailed")); return; }
      const list = (await res.json()) as Library[];
      setLibraries(list);
      const activeStates: Record<string, ScanState> = {};
      const activeLoading: Record<string, boolean> = {};
      for (const lib of list) {
        if (lib.activeScan && !isTerminalScan(lib.activeScan)) {
          activeStates[lib.id] = lib.activeScan;
          activeLoading[lib.id] = true;
          attachScanStream(lib.id, lib.activeScan.jobId);
        }
      }
      setScanStates((s) => ({ ...s, ...activeStates }));
      setScanLoading((s) => ({ ...s, ...activeLoading }));
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

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const path = pendingDelete.kind === "library" ? `/libraries/${pendingDelete.id}` : `/sources/${pendingDelete.id}`;
      await apiFetch(path, { method: "DELETE" });
      await refresh();
      setPendingDelete(null);
    } catch {
      setError(t("errors:network"));
    } finally {
      setDeleting(false);
    }
  }

  function startRename(lib: Library) {
    setEditingLibraryId(lib.id);
    setRenameName(lib.name);
    setRenameErrors((s) => ({ ...s, [lib.id]: "" }));
  }

  function cancelRename() {
    setEditingLibraryId(null);
    setRenameName("");
  }

  async function handleRenameLibrary(e: React.FormEvent, lib: Library) {
    e.preventDefault();
    const name = renameName.trim();
    setRenameErrors((s) => ({ ...s, [lib.id]: "" }));

    if (!name) {
      setRenameErrors((s) => ({ ...s, [lib.id]: errorMessage("invalid", t) }));
      return;
    }
    if (name === lib.name) {
      cancelRename();
      return;
    }

    setRenameSaving(lib.id);
    try {
      const res = await apiFetch(`/libraries/${lib.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      if (res.ok) {
        cancelRename();
        await refresh();
      } else {
        const body = (await res.json()) as { error?: string };
        setRenameErrors((s) => ({ ...s, [lib.id]: body.error ? errorMessage(body.error, t) : t("libraries:errors.renameFailed") }));
      }
    } catch {
      setRenameErrors((s) => ({ ...s, [lib.id]: t("errors:network") }));
    } finally {
      setRenameSaving(null);
    }
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
      const { jobId, scan } = (await res.json()) as { jobId: string; active?: boolean; scan?: Library["activeScan"] };
      esRef.current.get(libraryId)?.close();
      esRef.current.delete(libraryId);
      if (scan) setScanStates((s) => ({ ...s, [libraryId]: scan }));
      attachScanStream(libraryId, jobId);
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

  function scanPercent(state: ScanState | undefined): number | null {
    if (!state || state.processed === undefined || state.total === undefined || state.total <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((state.processed / state.total) * 100)));
  }

  function summaryFor(lib: Library) {
    return lib.summary ?? {
      totalItems: 0,
      enrichedItems: 0,
      missingMetadata: 0,
      missingArtwork: 0,
      files: 0,
      sourceCount: lib.sources.length,
      enabledSourceCount: lib.sources.filter((s) => s.enabled).length,
      sourceErrorCount: lib.sources.filter((s) => s.status === "error").length,
      lastScanAt: lib.sources
        .map((s) => s.lastScanAt)
        .filter((d): d is string => Boolean(d))
        .sort()
        .at(-1) ?? null,
    };
  }

  function formatDate(value: string | null): string {
    if (!value) return t("libraries:stats.neverScanned");
    return new Date(value).toLocaleString();
  }

  function sourceLabel(src: Source): string {
    return src.kind === "smb"
      ? `smb://${src.smbHost ?? "?"}/${src.smbShare ?? "?"}${src.smbSubpath ? "/" + src.smbSubpath : ""}`
      : src.path ?? "";
  }

  if (loading) {
    return (
      <main className="flex flex-col gap-4">
        <Skeleton rounded="sm" className="h-9 w-64" />
        {[0, 1].map((i) => (
          <Card key={i} className="p-3">
            <div className="grid gap-3 xl:grid-cols-[minmax(220px,1.1fr)_minmax(480px,1.6fr)_auto] xl:items-center">
              <Skeleton rounded="sm" className="h-6 w-40" />
              <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
                {Array.from({ length: 6 }).map((_, j) => (
                  <Skeleton key={j} rounded="sm" className="h-12 w-full" />
                ))}
              </div>
              <Skeleton rounded="sm" className="h-9 w-40 justify-self-end" />
            </div>
          </Card>
        ))}
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-[var(--text)]">{t("libraries:title")}</h1>
            <Link to="/account/settings" className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]">{t("libraries:settingsLink")}</Link>
          </div>
          <p className="mt-1 text-sm text-[var(--text-dim)]">
            {t("libraries:overview", {
              libraries: libraries.length,
              items: libraries.reduce((sum, lib) => sum + summaryFor(lib).totalItems, 0),
              missing: libraries.reduce((sum, lib) => sum + summaryFor(lib).missingMetadata, 0),
            })}
          </p>
        </div>

        <form onSubmit={handleCreateLibrary} className="flex w-full gap-2 xl:max-w-md">
          <Input value={newLibName} onChange={(e) => setNewLibName(e.target.value)} placeholder={t("libraries:add.namePlaceholder")} required />
          <Button type="submit" disabled={libSaving}>{libSaving ? t("libraries:adding") : t("common:actions.add")}</Button>
        </form>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {libError && <p className="text-sm text-[var(--danger)]">{libError}</p>}

      {/* Library list */}
      {libraries.length === 0 && (
        <Card className="py-8 text-center text-sm text-[var(--text-dim)]">
          {t("libraries:empty")}
        </Card>
      )}
      {libraries.map((lib) => {
        const d = draftFor(lib.id);
        const isRenaming = editingLibraryId === lib.id;
        const isExpanded = expandedLibraryId === lib.id;
        const summary = summaryFor(lib);
        const scanState = scanStates[lib.id] ?? lib.activeScan ?? undefined;
        const percent = scanPercent(scanState);
        const isScanning = scanLoading[lib.id] || (scanState != null && !isTerminalScan(scanState));
        return (
        <Card key={lib.id} className="p-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(220px,1.1fr)_minmax(480px,1.6fr)_auto] xl:items-center">
            <div className="min-w-0">
              {isRenaming ? (
                <form onSubmit={(e) => handleRenameLibrary(e, lib)} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    aria-label={t("libraries:rename.nameLabel")}
                    required
                    autoFocus
                    className="min-w-0 flex-1 text-lg font-semibold"
                  />
                  <div className="flex shrink-0 gap-2">
                    <Button type="submit" disabled={renameSaving === lib.id} className="px-3 py-1.5 text-sm">
                      {renameSaving === lib.id ? t("common:status.saving") : t("common:actions.save")}
                    </Button>
                    <Button variant="ghost" onClick={cancelRename} disabled={renameSaving === lib.id} className="px-3 py-1.5 text-sm">
                      {t("common:actions.cancel")}
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <h2 className="truncate text-lg font-semibold text-[var(--text)]">{lib.name}</h2>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-dim)]">
                    {t("libraries:stats.sources", { count: summary.enabledSourceCount, total: summary.sourceCount })}
                    {" · "}
                    {t("libraries:stats.lastScan", { value: formatDate(summary.lastScanAt) })}
                  </p>
                </>
              )}
              {renameErrors[lib.id] && (
                <p className="mt-1 text-sm text-[var(--danger)]">{renameErrors[lib.id]}</p>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {[
                [t("libraries:stats.items"), summary.totalItems],
                [t("libraries:stats.enriched"), summary.enrichedItems],
                [t("libraries:stats.missingMetadata"), summary.missingMetadata],
                [t("libraries:stats.missingArtwork"), summary.missingArtwork],
                [t("libraries:stats.files"), summary.files],
                [t("libraries:stats.sourceErrors"), summary.sourceErrorCount],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--bg)]/35 px-2 py-1.5">
                  <dt className="truncate text-[11px] uppercase text-[var(--text-dim)]">{label}</dt>
                  <dd className="text-base font-semibold text-[var(--text)]">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="flex flex-wrap gap-2 xl:justify-end">
              <Button onClick={() => handleScan(lib.id)} disabled={isScanning} className="px-3 py-1.5 text-sm">
                {isScanning ? t("libraries:scan.scanning") : t("libraries:scan.button")}
              </Button>
              {!isRenaming && (
                <Button variant="ghost" onClick={() => startRename(lib)} className="px-3 py-1.5 text-sm">
                  {t("libraries:rename.button")}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setExpandedLibraryId(isExpanded ? null : lib.id)} className="px-3 py-1.5 text-sm">
                {isExpanded ? t("libraries:actions.hideSources") : t("libraries:actions.manageSources")}
              </Button>
              <Button variant="ghost" onClick={() => setPendingDelete({ kind: "library", id: lib.id, name: lib.name })} className="px-3 py-1.5 text-sm">{t("common:actions.delete")}</Button>
            </div>
          </div>

          {scanState && (
            <div className="mt-3 flex flex-col gap-1" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-dim)]">
                <span>{formatScanState(scanState)}</span>
                {percent !== null && <span>{percent}%</span>}
              </div>
              {percent !== null && (
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${percent}%` }} />
                </div>
              )}
            </div>
          )}

          {isExpanded && (
            <div className="mt-4 grid gap-4 border-t border-[var(--surface-2)] pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
              <div>
                <h3 className="mb-2 text-sm font-medium text-[var(--text)]">{t("libraries:source.heading")}</h3>
                {lib.sources.length === 0 ? (
                  <p className="text-sm text-[var(--text-dim)]">{t("libraries:source.empty")}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {lib.sources.map((src) => (
                      <li key={src.id} className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] bg-[var(--bg)]/30 px-2 py-1.5 text-sm text-[var(--text-dim)]">
                        <span className="min-w-0 truncate font-mono">
                          {sourceLabel(src)}
                          {src.status === "error" && <span className="ml-2 text-[var(--danger)]">({t("libraries:source.errorLabel")}: {src.statusMessage})</span>}
                        </span>
                        <Button variant="ghost" onClick={() => setPendingDelete({ kind: "source", id: src.id, name: sourceLabel(src) })} className="shrink-0 px-2 py-1 text-xs">{t("common:actions.remove")}</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <form onSubmit={(e) => handleCreateSource(e, lib.id)} className="flex flex-col gap-2">
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
                {sourceErrors[lib.id] && <p className="text-sm text-[var(--danger)]">{sourceErrors[lib.id]}</p>}
              </form>
              </div>
          )}
        </Card>
        );
      })}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? t("common:confirmDelete.title", { name: pendingDelete.name }) : ""}
        description={
          pendingDelete?.kind === "library"
            ? t("libraries:deleteLibraryConfirm", { name: pendingDelete.name })
            : pendingDelete
              ? t("libraries:deleteSourceConfirm")
              : undefined
        }
        confirmLabel={t("common:actions.delete")}
        cancelLabel={t("common:actions.cancel")}
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </main>
  );
}
