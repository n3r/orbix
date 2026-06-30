import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Avatar, Button } from "@orbix/ui";
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

export default function AccountOverview() {
  const { t } = useTranslation();
  const { data } = useMyProfile();

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Avatar name={data?.name ?? "?"} src={data?.avatar ?? undefined} size={64} />
        <div>
          <p className="text-lg font-medium text-[var(--text)]">{data?.name ?? ""}</p>
          <p className="text-sm text-[var(--text-dim)]">
            {data?.kind === "kids" ? t("account:profileKind.kids") : t("account:profileKind.standard")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--text-dim)]">{t("common:language")}</label>
        <LanguageSwitcher
          persistToProfileId={data?.id ?? undefined}
          className="w-full max-w-xs rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link to="/profiles">
          <Button variant="ghost">{t("nav:switchProfile")}</Button>
        </Link>
        <Button variant="ghost" onClick={handleLogout}>{t("nav:logout")}</Button>
      </div>
    </section>
  );
}
