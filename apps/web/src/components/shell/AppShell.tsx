import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import type { Library, Profile } from "@/lib/types";

export default function AppShell({
  libraries,
  profile,
  isKids,
  children,
}: {
  libraries: Library[];
  profile: Profile | null;
  isKids: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { t } = useTranslation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-screen">
      {/* Desktop rail — persistent across in-group navigations */}
      <Sidebar
        className="hidden md:flex sticky top-0 h-screen w-64 shrink-0"
        libraries={libraries}
        profile={profile}
        isKids={isKids}
      />

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <Sidebar
            className="relative flex h-full w-72"
            libraries={libraries}
            profile={profile}
            isKids={isKids}
            onNavigate={() => setOpen(false)}
          />
        </div>
      )}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar className="md:hidden" onMenu={() => setOpen(true)} />
        <main className="min-w-0 flex-1">{children}</main>
        <footer className="py-4 px-6 md:px-8 text-center text-xs text-[var(--text-dim)]">
          {t("nav:tmdbAttribution")}
        </footer>
      </div>
    </div>
  );
}
