import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Card, Input, Skeleton } from "@orbix/ui";
import { apiJson } from "@/lib/api";
import type { TvAdminChannel } from "@/lib/types";
import { regionName } from "@/lib/tv";

const LIMIT = 50;

/**
 * Admin card: searchable, paged channel manager (INCLUDES hidden channels,
 * unlike the member-facing guide/home). Per-field edits (number, epgId,
 * hidden, kidsAllowed) each PATCH `/tv/admin/channels/:id` and invalidate the
 * list. Country filter must be sent uppercase — the API stores/matches
 * country codes verbatim (e.g. "RU"), it does not case-normalize `?country=`.
 */
export function TvChannelManagerCard() {
  const { t, i18n } = useTranslation("tv");
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [debouncedCountry, setDebouncedCountry] = useState("");
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, { epgId?: string; number?: string }>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 300 ms debounce, shared by search text and the country filter (matches
  // TvGuidePage's search debounce).
  useEffect(() => {
    const h = setTimeout(() => {
      setDebouncedQ(q.trim());
      setDebouncedCountry(country.trim().toUpperCase());
      setPage(0);
    }, 300);
    return () => clearTimeout(h);
  }, [q, country]);

  const { data, isLoading } = useQuery({
    queryKey: ["tv-admin-channels", debouncedQ, debouncedCountry, page],
    queryFn: () => {
      const qs = new URLSearchParams({
        q: debouncedQ,
        country: debouncedCountry,
        offset: String(page * LIMIT),
        limit: String(LIMIT),
      });
      return apiJson<{ total: number; channels: TvAdminChannel[] }>(`/tv/admin/channels?${qs}`);
    },
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiJson<TvAdminChannel>(`/tv/admin/channels/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (_res, vars) => {
      setError(null);
      setSavedId(vars.id);
      void queryClient.invalidateQueries({ queryKey: ["tv-admin-channels"] });
    },
    onError: () => setError(t("admin.saveFailed")),
  });

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * LIMIT + 1;
  const to = Math.min(total, (page + 1) * LIMIT);

  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold text-[var(--text)]">{t("manager.title")}</h3>
      <p className="mb-4 text-xs text-[var(--text-dim)]">{t("manager.intro")}</p>

      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-64 flex-1"
          placeholder={t("manager.search")}
          aria-label={t("manager.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Input
          className="w-32"
          placeholder={t("manager.countryPlaceholder")}
          aria-label={t("manager.countryPlaceholder")}
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase())}
        />
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="text-left text-xs uppercase text-[var(--text-dim)]">
            <tr>
              <th className="px-2 py-1">{t("manager.columns.number")}</th>
              <th className="px-2 py-1" />
              <th className="px-2 py-1">{t("manager.columns.channel")}</th>
              <th className="px-2 py-1">{t("manager.columns.country")}</th>
              <th className="px-2 py-1">{t("manager.columns.hidden")}</th>
              <th className="px-2 py-1">{t("manager.columns.kids")}</th>
              <th className="px-2 py-1">{t("manager.columns.epgId")}</th>
            </tr>
          </thead>
          <tbody className="text-[var(--text)]">
            {isLoading &&
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-t border-[var(--surface-2)]">
                  <td className="px-2 py-1.5" colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </td>
                </tr>
              ))}
            {(data?.channels ?? []).map((c) => {
              const draft = drafts[c.id] ?? {};
              return (
                <tr key={c.id} className="border-t border-[var(--surface-2)]">
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1">
                      <Input
                        type="number"
                        className="w-16 tabular-nums"
                        aria-label={t("manager.numberLabel", { name: c.name })}
                        value={draft.number ?? String(c.number)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], number: e.target.value } }))}
                      />
                      <Button
                        variant="ghost"
                        disabled={patch.isPending}
                        onClick={() => {
                          const n = Number.parseInt(draft.number ?? String(c.number), 10);
                          if (Number.isInteger(n) && n >= 1) patch.mutate({ id: c.id, body: { number: n } });
                        }}
                      >
                        {t("manager.save")}
                      </Button>
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    {c.logo ? (
                      <img src={c.logo} alt="" className="h-6 w-10 object-contain" />
                    ) : (
                      <span className="inline-block h-6 w-10 rounded bg-[var(--surface-2)]" />
                    )}
                  </td>
                  <td className="max-w-56 truncate px-2 py-1.5">{c.name}</td>
                  <td className="px-2 py-1.5 text-[var(--text-dim)]">{regionName(c.country, i18n.language) ?? "—"}</td>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={c.hidden}
                      aria-label={t("manager.hiddenToggle", { name: c.name })}
                      onChange={(e) => patch.mutate({ id: c.id, body: { hidden: e.target.checked } })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={c.kidsAllowed}
                      aria-label={t("manager.kidsToggle", { name: c.name })}
                      onChange={(e) => patch.mutate({ id: c.id, body: { kidsAllowed: e.target.checked } })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1">
                      <Input
                        className="w-40"
                        placeholder={t("manager.epgIdPlaceholder")}
                        value={draft.epgId ?? c.epgId ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], epgId: e.target.value } }))}
                      />
                      <Button
                        variant="ghost"
                        disabled={patch.isPending}
                        onClick={() => patch.mutate({ id: c.id, body: { epgId: (draft.epgId ?? c.epgId ?? "").trim() || null } })}
                      >
                        {t("manager.save")}
                      </Button>
                      {savedId === c.id && <span className="text-xs text-green-400">{t("manager.saved")}</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && data.channels.length === 0 && <p className="mt-3 text-sm text-[var(--text-dim)]">{t("manager.empty")}</p>}
      </div>

      <div className="mt-3 flex items-center justify-between text-sm text-[var(--text-dim)]">
        <span>{t("manager.pageOf", { from, to, total })}</span>
        <span className="flex gap-2">
          <Button variant="ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            {t("manager.prev")}
          </Button>
          <Button variant="ghost" disabled={to >= total} onClick={() => setPage((p) => p + 1)}>
            {t("manager.next")}
          </Button>
        </span>
      </div>
    </Card>
  );
}
