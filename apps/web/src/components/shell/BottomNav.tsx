import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { cn, focusRing, useFocusTrap } from "@orbix/ui";
import { useMenu } from "@/lib/queries";
import type { Profile } from "@/lib/types";
import { HomeIcon, TvIcon, SearchIcon, UserIcon } from "./icons";

function Tab({ to, label, active, onClick, children }: {
  to?: string; label: string; active?: boolean; onClick?: () => void; children: React.ReactNode;
}) {
  const cls = cn(
    "flex flex-1 flex-col items-center gap-1 py-2 text-[10px]",
    focusRing,
    active ? "text-[var(--text)]" : "text-[var(--text-dim)]",
  );
  if (to) return <Link to={to} className={cls} aria-current={active ? "page" : undefined}>{children}<span>{label}</span></Link>;
  return <button type="button" onClick={onClick} className={cls} aria-label={label}>{children}<span>{label}</span></button>;
}

export default function BottomNav({ profile }: { profile: Profile | null }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const menu = useMenu();
  const items = menu.data?.items ?? [];

  const closeCatalog = useCallback(() => setCatalogOpen(false), []);
  // Focus moves into the sheet on open, Tab is trapped, Escape closes it, and
  // focus returns to the Catalog tab on close.
  const sheetRef = useFocusTrap<HTMLDivElement>(catalogOpen, { onEscape: closeCatalog });

  // Close the sheet whenever the route changes.
  useEffect(() => { setCatalogOpen(false); }, [pathname]);

  return (
    <>
      {catalogOpen && (
        <div
          ref={sheetRef}
          className="fixed inset-0 z-[var(--z-overlay)] md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t("nav:catalog")}
        >
          <div className="absolute inset-0 bg-black/60" onClick={closeCatalog} aria-hidden />
          <div className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-[var(--surface-2)] bg-[var(--surface)] p-4 pb-24">
            <p className="px-2 pb-2 text-xs uppercase tracking-wide text-[var(--text-dim)]">{t("nav:catalog")}</p>
            {items.length === 0 && <p className="px-2 py-3 text-sm text-[var(--text-dim)]">{t("nav:noCategories")}</p>}
            <div className="flex flex-col">
              {items.map((item) => (
                <Link
                  key={item.libraryId}
                  to={`/library/${item.libraryId}`}
                  className={cn(
                    "rounded-[var(--radius-sm)] px-2 py-3 text-[var(--text)] hover:bg-[var(--surface-2)]",
                    focusRing,
                  )}
                >
                  {item.name}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--surface-2)] bg-[var(--surface)]/95 backdrop-blur md:hidden">
        <Tab to="/" label={t("nav:home")} active={pathname === "/"}><HomeIcon className="h-5 w-5" /></Tab>
        {profile?.kind !== "kids" && (
          <Tab to="/tv" label={t("nav:tv")} active={pathname.startsWith("/tv")}>
            <TvIcon className="h-5 w-5" />
          </Tab>
        )}
        <Tab label={t("nav:catalog")} active={catalogOpen} onClick={() => setCatalogOpen((v) => !v)}>
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </Tab>
        <Tab to="/search" label={t("nav:search")} active={pathname === "/search"}><SearchIcon className="h-5 w-5" /></Tab>
        <Tab to="/account" label={t("nav:account")} active={pathname.startsWith("/account")}><UserIcon className="h-5 w-5" /></Tab>
      </nav>
    </>
  );
}
