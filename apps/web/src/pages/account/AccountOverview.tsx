import { Link } from "react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, Button, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { useMyProfile } from "@/lib/queries";
import LanguageSwitcher from "@/components/LanguageSwitcher";

async function handleLogout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // Navigate regardless so the user isn't stuck.
  }
  window.location.href = "/login";
}

function pinIsValid(pin: string) {
  return /^\d{4,6}$/.test(pin);
}

export default function AccountOverview() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useMyProfile();
  const [pin, setPin] = useState("");
  const [pinSaving, setPinSaving] = useState(false);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  const profileKind =
    data?.isGroup && data.kind === "kids"
      ? t("account:profileKind.groupKids")
      : data?.isGroup
        ? t("account:profileKind.group")
        : data?.kind === "kids"
          ? t("account:profileKind.kids")
          : t("account:profileKind.standard");
  const canManageProfileCode = data?.kind !== "kids";

  async function patchProfilePin(nextPin: string) {
    if (!data?.id) return;
    setPinSaving(true);
    setPinMessage(null);
    setPinError(null);
    try {
      const res = await apiFetch(`/profiles/${data.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pin: nextPin }),
      });
      if (!res.ok) {
        setPinError(t("account:pin.saveFailed"));
        return;
      }
      setPin("");
      setPinMessage(nextPin ? t("account:pin.saved") : t("account:pin.removed"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["me-profile"] }),
        queryClient.invalidateQueries({ queryKey: ["profiles"] }),
      ]);
    } catch {
      setPinError(t("errors:network"));
    } finally {
      setPinSaving(false);
    }
  }

  async function handlePinSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pinIsValid(pin)) {
      setPinMessage(null);
      setPinError(t("account:pin.invalid"));
      return;
    }
    await patchProfilePin(pin);
  }

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Avatar name={data?.name ?? "?"} src={data?.avatar ?? undefined} size={64} />
        <div>
          <p className="text-lg font-medium text-[var(--text)]">{data?.name ?? ""}</p>
          <p className="text-sm text-[var(--text-dim)]">{profileKind}</p>
          {data?.isGroup && data.members && data.members.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {data.members.map((member) => (
                <span
                  key={member.id}
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-dim)]"
                >
                  <Avatar name={member.name} src={member.avatar ?? undefined} size={20} />
                  {member.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--text-dim)]">{t("common:language")}</label>
        <LanguageSwitcher
          persistToProfileId={data?.id ?? undefined}
          className="w-full max-w-xs rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
        />
      </div>

      {canManageProfileCode && (
        <form onSubmit={handlePinSubmit} className="flex max-w-sm flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="profile-code" className="text-sm font-medium text-[var(--text-dim)]">
              {t("account:pin.label")}
            </label>
            <span className="text-xs text-[var(--text-dim)]">
              {data?.hasPin ? t("account:pin.enabled") : t("account:pin.disabled")}
            </span>
          </div>
          <Input
            id="profile-code"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            pattern="[0-9]{4,6}"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder={t("account:pin.placeholder")}
          />
          {pinMessage && <p className="text-sm text-emerald-400">{pinMessage}</p>}
          {pinError && <p className="text-sm text-red-400">{pinError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pinSaving || !data?.id}>
              {pinSaving ? t("common:status.saving") : t("account:pin.save")}
            </Button>
            {data?.hasPin && (
              <Button
                type="button"
                variant="ghost"
                disabled={pinSaving}
                onClick={() => void patchProfilePin("")}
              >
                {t("account:pin.remove")}
              </Button>
            )}
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-3">
        <Link to="/profiles">
          <Button variant="ghost">{t("nav:switchProfile")}</Button>
        </Link>
        <Button variant="ghost" onClick={handleLogout}>{t("nav:logout")}</Button>
      </div>
    </section>
  );
}
