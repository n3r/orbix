import { NavLink, Outlet, Navigate, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import { useAuthMe, useMyProfile } from "@/lib/queries";

const tab = ({ isActive }: { isActive: boolean }) =>
  cn(
    "border-b-2 px-1 pb-2 text-sm transition-colors",
    isActive
      ? "border-[var(--accent)] text-[var(--text)]"
      : "border-transparent text-[var(--text-dim)] hover:text-[var(--text)]",
  );

export default function AccountLayout() {
  const { t } = useTranslation();
  const me = useAuthMe();
  const profile = useMyProfile();
  const { pathname } = useLocation();

  const isKids = profile.data?.kind === "kids";
  const isAdmin = (me.data?.isAdmin ?? false) && !isKids;

  // Guard the admin tabs: a non-admin who deep-links to /account/library|settings
  // is bounced to the overview. Wait for the queries to settle first.
  const onAdminTab = pathname.startsWith("/account/library") || pathname.startsWith("/account/settings");
  if (onAdminTab && !me.isLoading && !profile.isLoading && !isAdmin) {
    return <Navigate to="/account" replace />;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 md:px-8 py-8">
      <h1 className="text-2xl font-semibold text-[var(--text)]">{t("account:title")}</h1>
      <nav className="mt-4 flex gap-6 border-b border-[var(--surface-2)]">
        <NavLink to="/account" end className={tab}>{t("account:tabs.overview")}</NavLink>
        <NavLink to="/account/menu" className={tab}>{t("account:tabs.menu")}</NavLink>
        {isAdmin && <NavLink to="/account/library" className={tab}>{t("nav:library")}</NavLink>}
        {isAdmin && <NavLink to="/account/settings" className={tab}>{t("nav:settings")}</NavLink>}
      </nav>
      <div className="pt-6">
        <Outlet />
      </div>
    </div>
  );
}
