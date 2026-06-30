"use client";

import { useState, useEffect, useRef } from "react";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

interface Source {
  id: string;
  path: string;
}

interface Section {
  id: string;
  name: string;
  order: number;
  sources?: Source[];
}

interface Library {
  id: string;
  name: string;
  sections: Section[];
}

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

export default function AdminLibrariesPage() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // New library form
  const [newLibName, setNewLibName] = useState("");
  const [libSaving, setLibSaving] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);

  // New section form state: keyed by libraryId
  const [sectionForms, setSectionForms] = useState<Record<string, string>>({});
  const [sectionSaving, setSectionSaving] = useState<Record<string, boolean>>({});

  // New source form state: keyed by sectionId
  const [sourceForms, setSourceForms] = useState<Record<string, string>>({});
  const [sourceSaving, setSourceSaving] = useState<Record<string, boolean>>({});
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});

  // Scan state: keyed by sectionId
  const [scanStates, setScanStates] = useState<Record<string, ScanState>>({});
  const [scanLoading, setScanLoading] = useState<Record<string, boolean>>({});

  // Track active EventSources so we can close them on unmount
  const esRef = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    const sources = esRef.current;
    return () => { sources.forEach((es) => es.close()); sources.clear(); };
  }, []);

  async function loadLibraries() {
    try {
      const res = await apiFetch("/libraries");
      if (!res.ok) {
        setError("Failed to load libraries");
        return;
      }
      const data = (await res.json()) as Library[];
      setLibraries(data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLibraries();
  }, []);

  async function handleCreateLibrary(e: React.FormEvent) {
    e.preventDefault();
    setLibError(null);
    setLibSaving(true);
    try {
      const res = await apiFetch("/libraries", {
        method: "POST",
        body: JSON.stringify({ name: newLibName }),
      });
      if (res.ok) {
        setNewLibName("");
        await loadLibraries();
      } else {
        const body = (await res.json()) as { error?: string };
        setLibError(body.error ?? "Failed to create library");
      }
    } catch {
      setLibError("Network error");
    } finally {
      setLibSaving(false);
    }
  }

  async function handleDeleteLibrary(id: string) {
    await apiFetch(`/libraries/${id}`, { method: "DELETE" });
    await loadLibraries();
  }

  async function handleCreateSection(e: React.FormEvent, libraryId: string) {
    e.preventDefault();
    setSectionSaving((s) => ({ ...s, [libraryId]: true }));
    try {
      const name = sectionForms[libraryId] ?? "";
      const res = await apiFetch("/sections", {
        method: "POST",
        body: JSON.stringify({ libraryId, name, order: 0 }),
      });
      if (res.ok) {
        setSectionForms((s) => ({ ...s, [libraryId]: "" }));
        await loadLibraries();
      }
    } catch {
      // ignore
    } finally {
      setSectionSaving((s) => ({ ...s, [libraryId]: false }));
    }
  }

  async function handleDeleteSection(id: string) {
    await apiFetch(`/sections/${id}`, { method: "DELETE" });
    await loadLibraries();
  }

  async function handleCreateSource(e: React.FormEvent, sectionId: string) {
    e.preventDefault();
    setSourceErrors((s) => ({ ...s, [sectionId]: "" }));
    setSourceSaving((s) => ({ ...s, [sectionId]: true }));
    try {
      const folderPath = sourceForms[sectionId] ?? "";
      const res = await apiFetch("/sources", {
        method: "POST",
        body: JSON.stringify({ sectionId, path: folderPath }),
      });
      if (res.ok) {
        setSourceForms((s) => ({ ...s, [sectionId]: "" }));
        await loadLibraries();
      } else {
        const body = (await res.json()) as { error?: string };
        setSourceErrors((s) => ({
          ...s,
          [sectionId]: body.error ?? "Failed to add source",
        }));
      }
    } catch {
      setSourceErrors((s) => ({ ...s, [sectionId]: "Network error" }));
    } finally {
      setSourceSaving((s) => ({ ...s, [sectionId]: false }));
    }
  }

  async function handleDeleteSource(id: string) {
    await apiFetch(`/sources/${id}`, { method: "DELETE" });
    await loadLibraries();
  }

  async function handleScan(sectionId: string) {
    setScanLoading((s) => ({ ...s, [sectionId]: true }));
    setScanStates((s) => ({ ...s, [sectionId]: { phase: "starting" } }));
    try {
      const res = await apiFetch(`/sections/${sectionId}/scan`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setScanStates((s) => ({
          ...s,
          [sectionId]: { phase: "error: " + (body.error ?? "unknown") },
        }));
        setScanLoading((s) => ({ ...s, [sectionId]: false }));
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };

      // Open SSE stream (same-origin via Next.js proxy rewrite)
      // Close any prior EventSource for this section before opening a new one
      esRef.current.get(sectionId)?.close();
      const es = new EventSource(`/api/scan/${jobId}/stream`);
      esRef.current.set(sectionId, es);

      es.onmessage = (event: MessageEvent<string>) => {
        const data = JSON.parse(event.data) as ScanState;
        setScanStates((s) => ({ ...s, [sectionId]: data }));
        if (data.phase === "done" || data.phase === "error") {
          es.close();
          esRef.current.delete(sectionId);
          setScanLoading((s) => ({ ...s, [sectionId]: false }));
          if (data.phase === "done") void loadLibraries();
        }
      };

      es.onerror = () => {
        setScanStates((s) => ({ ...s, [sectionId]: { phase: "stream error" } }));
        es.close();
        esRef.current.delete(sectionId);
        setScanLoading((s) => ({ ...s, [sectionId]: false }));
      };
    } catch {
      setScanStates((s) => ({ ...s, [sectionId]: { phase: "error" } }));
      setScanLoading((s) => ({ ...s, [sectionId]: false }));
    }
  }

  function formatScanState(state: ScanState): string {
    if (state.phase === "done") {
      return `Done — added: ${state.added ?? 0}, updated: ${state.updated ?? 0}, matched: ${state.matched ?? 0}`;
    }
    if (state.phase === "error") {
      return `Scan failed: ${state.message ?? "unknown error"}`;
    }
    if (state.processed !== undefined && state.total !== undefined) {
      return `${state.phase}: ${state.processed}/${state.total}`;
    }
    return state.phase;
  }

  if (loading) {
    return (
      <main className="p-8">
        <p className="text-[var(--text-dim)]">Loading…</p>
      </main>
    );
  }

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
     <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-[var(--text)]">Libraries</h1>
        <a
          href="/admin/settings"
          className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          Settings
        </a>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Create Library Form */}
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Add Library</h2>
        <form onSubmit={handleCreateLibrary} className="flex gap-2">
          <Input
            value={newLibName}
            onChange={(e) => setNewLibName(e.target.value)}
            placeholder="Library name"
            required
          />
          <Button type="submit" disabled={libSaving}>
            {libSaving ? "Adding…" : "Add"}
          </Button>
        </form>
        {libError && <p className="mt-2 text-sm text-red-400">{libError}</p>}
      </Card>

      {/* Library List */}
      {libraries.map((lib) => (
        <Card key={lib.id}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-[var(--text)]">{lib.name}</h2>
            <Button
              variant="ghost"
              onClick={() => handleDeleteLibrary(lib.id)}
            >
              Delete Library
            </Button>
          </div>

          {/* Sections */}
          <div className="flex flex-col gap-4 ml-4">
            {lib.sections.map((section) => (
              <div key={section.id} className="border border-[var(--border,#333)] rounded p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-[var(--text)]">{section.name}</h3>
                  <div className="flex gap-2 items-center">
                    <Button
                      onClick={() => handleScan(section.id)}
                      disabled={scanLoading[section.id]}
                    >
                      {scanLoading[section.id] ? "Scanning…" : "Scan"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleDeleteSection(section.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>

                {/* Scan progress */}
                {scanStates[section.id] && (
                  <p className="text-sm text-[var(--text-dim)] mb-3">
                    {formatScanState(scanStates[section.id]!)}
                  </p>
                )}

                {/* Sources */}
                {section.sources && section.sources.length > 0 && (
                  <ul className="mb-3 flex flex-col gap-1">
                    {section.sources.map((src) => (
                      <li
                        key={src.id}
                        className="flex items-center justify-between text-sm text-[var(--text-dim)]"
                      >
                        <span className="font-mono">{src.path}</span>
                        <Button
                          variant="ghost"
                          onClick={() => handleDeleteSource(src.id)}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Add Source Form */}
                <form
                  onSubmit={(e) => handleCreateSource(e, section.id)}
                  className="flex gap-2"
                >
                  <Input
                    value={sourceForms[section.id] ?? ""}
                    onChange={(e) =>
                      setSourceForms((s) => ({ ...s, [section.id]: e.target.value }))
                    }
                    placeholder="/path/to/media/folder"
                    required
                  />
                  <Button
                    type="submit"
                    disabled={sourceSaving[section.id]}
                  >
                    {sourceSaving[section.id] ? "Adding…" : "Add Source"}
                  </Button>
                </form>
                {sourceErrors[section.id] && (
                  <p className="mt-1 text-sm text-red-400">{sourceErrors[section.id]}</p>
                )}
              </div>
            ))}

            {/* Add Section Form */}
            <form
              onSubmit={(e) => handleCreateSection(e, lib.id)}
              className="flex gap-2"
            >
              <Input
                value={sectionForms[lib.id] ?? ""}
                onChange={(e) =>
                  setSectionForms((s) => ({ ...s, [lib.id]: e.target.value }))
                }
                placeholder="Section name (e.g. Movies)"
                required
              />
              <Button
                type="submit"
                disabled={sectionSaving[lib.id]}
              >
                {sectionSaving[lib.id] ? "Adding…" : "Add Section"}
              </Button>
            </form>
          </div>
        </Card>
      ))}
     </div>
    </main>
  );
}
