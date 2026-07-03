import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiJson, ApiError } from "@/lib/api";

interface Device {
  id: string;
  name: string;
  platform: string;
  activeProfileId: string | null;
  lastSeenAt: string;
  createdAt: string;
  revokedAt: string | null;
}

export default function AccountDevicesPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => apiJson<{ devices: Device[] }>("/devices"),
  });

  const [code, setCode] = useState("");
  const [pairMsg, setPairMsg] = useState<"approved" | "unknown" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const approve = useMutation({
    mutationFn: (c: string) =>
      apiJson<{ ok: true }>("/pair/approve", { method: "POST", body: JSON.stringify({ code: c }) }),
    onSuccess: () => {
      setPairMsg("approved");
      setCode("");
      void qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (e) => {
      setPairMsg(e instanceof ApiError && e.status === 404 ? "unknown" : null);
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiJson<{ ok: true }>(`/devices/${id}/revoke`, { method: "POST" }),
    onMutate: () => setActionError(null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["devices"] }),
    onError: () => setActionError(t("errors:network")),
  });

  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      apiJson<{ ok: true }>(`/devices/${v.id}`, { method: "PATCH", body: JSON.stringify({ name: v.name }) }),
    onMutate: () => setActionError(null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["devices"] }),
    onError: () => setActionError(t("errors:network")),
  });

  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-medium text-[var(--text)]">{t("account:devices.pairTitle")}</h2>
        <p className="mt-1 text-sm text-[var(--text-dim)]">{t("account:devices.pairHint")}</p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length === 6) approve.mutate(code.trim().toUpperCase());
          }}
        >
          <input
            value={code}
            onChange={(e) => { setCode(e.target.value.toUpperCase()); setPairMsg(null); }}
            maxLength={6}
            placeholder="ABC123"
            className="w-32 rounded bg-[var(--surface-2)] px-3 py-2 font-mono text-lg tracking-widest text-[var(--text)] outline-none"
            aria-label={t("account:devices.pairHint")}
          />
          <button
            type="submit"
            disabled={code.trim().length !== 6 || approve.isPending}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t("account:devices.pairButton")}
          </button>
        </form>
        {pairMsg === "approved" && <p className="mt-2 text-sm text-green-500">{t("account:devices.pairApproved")}</p>}
        {pairMsg === "unknown" && <p className="mt-2 text-sm text-red-400">{t("account:devices.pairUnknown")}</p>}
      </section>

      <section>
        <h2 className="text-lg font-medium text-[var(--text)]">{t("account:devices.title")}</h2>
        {actionError && <p className="mt-2 text-sm text-red-400">{actionError}</p>}
        {devices.data && devices.data.devices.length === 0 && (
          <p className="mt-2 text-sm text-[var(--text-dim)]">{t("account:devices.empty")}</p>
        )}
        <ul className="mt-3 divide-y divide-[var(--surface-2)]">
          {devices.data?.devices.map((d) => (
            <li key={d.id} className="flex items-center gap-4 py-3">
              <div className="min-w-0 flex-1">
                {editing?.id === d.id ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!editing.name.trim()) return;
                      rename.mutate(editing);
                      setEditing(null);
                    }}
                  >
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                      className="rounded bg-[var(--surface-2)] px-2 py-1 text-sm text-[var(--text)] outline-none"
                      aria-label={t("account:devices.rename")}
                    />
                    <button
                      type="submit"
                      disabled={!editing.name.trim() || rename.isPending}
                      className="text-sm text-[var(--accent)] disabled:opacity-50"
                    >
                      {t("account:devices.save")}
                    </button>
                  </form>
                ) : (
                  <p className="truncate text-sm text-[var(--text)]">
                    {d.name} <span className="text-[var(--text-dim)]">· {d.platform}</span>
                    {d.revokedAt && (
                      <span className="ml-2 rounded bg-red-950 px-2 py-0.5 text-xs text-red-400">
                        {t("account:devices.revoked")}
                      </span>
                    )}
                  </p>
                )}
                <p className="text-xs text-[var(--text-dim)]">
                  {t("account:devices.lastSeen")}: {fmt.format(new Date(d.lastSeenAt))}
                </p>
              </div>
              {!d.revokedAt && (
                <>
                  <button
                    onClick={() => setEditing({ id: d.id, name: d.name })}
                    className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
                  >
                    {t("account:devices.rename")}
                  </button>
                  <button
                    onClick={() => {
                      if (editing?.id === d.id) setEditing(null);
                      revoke.mutate(d.id);
                    }}
                    disabled={revoke.isPending}
                    className="text-sm text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    {t("account:devices.revoke")}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
