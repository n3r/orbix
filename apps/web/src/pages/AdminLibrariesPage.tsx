import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
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
      if (!res.ok) { setError("Failed to load libraries"); return; }
      setLibraries((await res.json()) as Library[]);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    await loadLibraries();
    void queryClient.invalidateQueries({ queryKey: ["libraries"] });
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
      else { const b = (await res.json()) as { error?: string }; setLibError(b.error ?? "Failed to create library"); }
    } catch {
      setLibError("Network error");
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
      else { const b = (await res.json()) as { error?: string }; setSourceErrors((s) => ({ ...s, [libraryId]: b.error ?? "Failed to add source" })); }
    } catch {
      setSourceErrors((s) => ({ ...s, [libraryId]: "Network error" }));
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
    setScanStates((s) => ({ ...s, [libraryId]: { phase: "starting" } }));
    try {
      const res = await apiFetch(`/libraries/${libraryId}/scan`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        setScanStates((s) => ({ ...s, [libraryId]: { phase: "error: " + (b.error ?? "unknown") } }));
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
        setScanStates((s) => ({ ...s, [libraryId]: { phase: "stream error" } }));
        es.close();
        esRef.current.delete(libraryId);
        setScanLoading((s) => ({ ...s, [libraryId]: false }));
      };
    } catch {
      setScanStates((s) => ({ ...s, [libraryId]: { phase: "error" } }));
      setScanLoading((s) => ({ ...s, [libraryId]: false }));
    }
  }

  function formatScanState(state: ScanState): string {
    if (state.phase === "done") return `Done — added: ${state.added ?? 0}, updated: ${state.updated ?? 0}, matched: ${state.matched ?? 0}`;
    if (state.phase === "error") return `Scan failed: ${state.message ?? "unknown error"}`;
    if (state.processed !== undefined && state.total !== undefined) return `${state.phase}: ${state.processed}/${state.total}${state.message ? ` — ${state.message}` : ""}`;
    return state.phase;
  }

  function sourceLabel(src: Source): string {
    return src.kind === "smb"
      ? `smb://${src.smbHost ?? "?"}/${src.smbShare ?? "?"}${src.smbSubpath ? "/" + src.smbSubpath : ""}`
      : src.path ?? "";
  }

  if (loading) {
    return <main className="p-8"><p className="text-[var(--text-dim)]">Loading…</p></main>;
  }

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
     <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-[var(--text)]">Libraries</h1>
        <Link to="/admin/settings" className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]">Settings</Link>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Create Library */}
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Add Library</h2>
        <form onSubmit={handleCreateLibrary} className="flex gap-2">
          <Input value={newLibName} onChange={(e) => setNewLibName(e.target.value)} placeholder="Library name" required />
          <Button type="submit" disabled={libSaving}>{libSaving ? "Adding…" : "Add"}</Button>
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
                {scanLoading[lib.id] ? "Scanning…" : "Scan"}
              </Button>
              <Button variant="ghost" onClick={() => handleDeleteLibrary(lib.id)}>Delete</Button>
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
                    {src.status === "error" && <span className="ml-2 text-red-400">(error: {src.statusMessage})</span>}
                  </span>
                  <Button variant="ghost" onClick={() => handleDeleteSource(src.id)}>Remove</Button>
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
                <option value="local">Local</option>
                <option value="smb">SMB</option>
              </select>
              {d.kind === "local" ? (
                <Input value={d.path} onChange={(e) => setDraft(lib.id, { path: e.target.value })} placeholder="/path/to/media/folder" required />
              ) : (
                <Input value={d.host} onChange={(e) => setDraft(lib.id, { host: e.target.value })} placeholder="NAS host (e.g. 192.168.1.10)" required />
              )}
              <Button type="submit" disabled={sourceSaving[lib.id]}>{sourceSaving[lib.id] ? "Adding…" : "Add Source"}</Button>
            </div>
            {d.kind === "smb" && (
              <div className="grid grid-cols-2 gap-2">
                <Input value={d.share} onChange={(e) => setDraft(lib.id, { share: e.target.value })} placeholder="Share (e.g. media)" required />
                <Input value={d.subpath} onChange={(e) => setDraft(lib.id, { subpath: e.target.value })} placeholder="Subpath (optional)" />
                <Input value={d.username} onChange={(e) => setDraft(lib.id, { username: e.target.value })} placeholder="Username (optional)" />
                <Input type="password" value={d.password} onChange={(e) => setDraft(lib.id, { password: e.target.value })} placeholder="Password (optional)" />
                <Input value={d.domain} onChange={(e) => setDraft(lib.id, { domain: e.target.value })} placeholder="Domain (optional)" />
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
