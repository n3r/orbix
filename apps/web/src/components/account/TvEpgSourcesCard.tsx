import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch, apiJson, ApiError } from "@/lib/api";
import type { TvEpgSource } from "@/lib/types";

/**
 * Admin card: XMLTV guide feeds (list/add/delete/enable-toggle/offset) plus a
 * manual "refresh now" trigger for the tv-epg ingest job. Sits below the
 * phase-2 iptv-org/M3U sources cards on `AccountTvPage` — same Card/Button/
 * Input idiom and row layout as `sourceRow` there.
 */
export function TvEpgSourcesCard() {
  const { t, i18n } = useTranslation("tv");
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<Record<string, string>>({});

  const { data: sources } = useQuery({
    queryKey: ["tv-epg-sources"],
    queryFn: () => apiJson<TvEpgSource[]>("/tv/epg-sources"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tv-epg-sources"] });

  const add = useMutation({
    mutationFn: () =>
      apiJson<TvEpgSource>("/tv/epg-sources", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), url: url.trim() }),
      }),
    onSuccess: () => {
      setName("");
      setUrl("");
      setError(null);
      setNotice(t("epg.added"));
      void invalidate();
    },
    onError: () => setError(t("admin.saveFailed")),
  });

  const patch = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Pick<TvEpgSource, "enabled" | "offsetMin">> }) =>
      apiJson<TvEpgSource>(`/tv/epg-sources/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: () => setError(t("admin.saveFailed")),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/tv/epg-sources/${id}`, { method: "DELETE" });
      if (!res.ok) throw new ApiError(res.status);
    },
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: () => setError(t("admin.saveFailed")),
  });

  const refresh = useMutation({
    mutationFn: () => apiJson<{ jobId: string }>("/tv/epg/refresh", { method: "POST" }),
    onSuccess: () => {
      setError(null);
      setNotice(t("epg.refreshStarted"));
    },
    onError: () => setError(t("admin.saveFailed")),
  });

  const statusLabel = (s: TvEpgSource) =>
    s.status === "syncing" ? t("epg.status.syncing") : s.status === "error" ? t("epg.status.error") : t("epg.status.ok");

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-1 text-lg font-semibold text-[var(--text)]">{t("epg.title")}</h3>
          <p className="text-xs text-[var(--text-dim)]">{t("epg.intro")}</p>
        </div>
        <Button variant="ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? t("epg.refreshing") : t("epg.refresh")}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {notice && <p className="mt-2 text-sm text-green-400">{notice}</p>}

      <div className="mt-4 flex flex-col">
        {(sources ?? []).map((s) => (
          <div key={s.id} className="flex flex-col gap-1 border-t border-[var(--surface-2)] py-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text)]">{s.name}</span>
                <span className="block truncate text-xs text-[var(--text-dim)]" title={s.url}>{s.url}</span>
              </span>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-dim)]">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  aria-label={s.enabled ? t("epg.enabled") : t("epg.disabled")}
                  onChange={(e) => patch.mutate({ id: s.id, data: { enabled: e.target.checked } })}
                />
                {t("epg.enabled")}
              </label>
              <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-dim)]">
                {t("epg.offsetMin")}
                <Input
                  type="number"
                  className="w-20"
                  value={offsets[s.id] ?? String(s.offsetMin)}
                  onChange={(e) => setOffsets((o) => ({ ...o, [s.id]: e.target.value }))}
                />
              </label>
              <Button
                variant="ghost"
                disabled={patch.isPending}
                onClick={() =>
                  patch.mutate({ id: s.id, data: { offsetMin: Number.parseInt(offsets[s.id] ?? String(s.offsetMin), 10) || 0 } })
                }
              >
                {t("manager.save")}
              </Button>
              <Button
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => { if (window.confirm(t("epg.deleteConfirm"))) remove.mutate(s.id); }}
              >
                {t("epg.delete")}
              </Button>
            </div>
            <p className="text-xs text-[var(--text-dim)]">
              {statusLabel(s)}
              {s.status === "error" && s.statusMessage ? ` — ${s.statusMessage}` : ""}
              {" · "}
              {t("epg.lastSync", { when: s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(i18n.language) : t("epg.never") })}
            </p>
          </div>
        ))}
        {sources && sources.length === 0 && <p className="text-sm text-[var(--text-dim)]">{t("epg.empty")}</p>}
      </div>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => { e.preventDefault(); if (name.trim() && url.trim()) add.mutate(); }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("epg.name")} required />
        <Input
          className="flex-1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("epg.url")}
          required
        />
        <Button type="submit" disabled={add.isPending}>{t("epg.add")}</Button>
      </form>
    </Card>
  );
}
