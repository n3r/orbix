import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { Avatar, cn } from "@orbix/ui";
import { useMenu } from "@/lib/queries";
import type { Profile } from "@/lib/types";
import NavCategories from "./NavCategories";
import { HomeIcon, TvIcon, HeartIcon, SearchIcon } from "./icons";

function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        setScrolled(window.scrollY > threshold);
        raf = 0;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [threshold]);
  return scrolled;
}

/** A visible-but-inert placeholder nav item (TV, Heart) for not-yet-built features. */
function Placeholder({ label, comingSoon, children }: { label: string; comingSoon: string; children: React.ReactNode }) {
  return (
    <span
      aria-disabled
      title={comingSoon}
      className="flex cursor-default items-center gap-1.5 text-sm text-[var(--text-dim)]/60"
    >
      {children}
      <span className="sr-only">{label} — {comingSoon}</span>
    </span>
  );
}

export default function TopNav({ profile }: { profile: Profile | null }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const scrolled = useScrolled();
  const menu = useMenu();
  const items = menu.data?.items ?? [];

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-40 transition-colors duration-300",
        scrolled
          ? "bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--surface)]"
          : "bg-gradient-to-b from-black/70 via-black/25 to-transparent",
      )}
    >
      <nav className="flex h-14 items-center justify-between gap-6 px-[4vw]">
        {/* Left cluster: wordmark + browse links (Netflix layout — mobile uses BottomNav). */}
        <div className="flex min-w-0 items-center gap-6 md:gap-8">
          <Link to="/" className="shrink-0 text-lg font-extrabold uppercase tracking-[0.25em] text-[var(--accent)]">
            {t("common:app.name")}
          </Link>
          <div className="hidden md:flex items-center gap-4">
            <Link
              to="/"
              aria-current={pathname === "/" ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 text-sm transition-colors",
                pathname === "/" ? "text-[var(--text)] font-medium" : "text-[var(--text-dim)] hover:text-[var(--text)]",
              )}
            >
              <HomeIcon className="h-4 w-4" /> {t("nav:home")}
            </Link>
            <Placeholder label={t("nav:tv")} comingSoon={t("nav:comingSoon")}><TvIcon className="h-4 w-4" /> {t("nav:tv")}</Placeholder>
            <NavCategories items={items} pathname={pathname} />
          </div>
        </div>

        {/* Right: heart · search · avatar */}
        <div className="flex shrink-0 items-center gap-4">
          <Placeholder label={t("nav:myList")} comingSoon={t("nav:comingSoon")}><HeartIcon /></Placeholder>
          <Link to="/search" aria-label={t("nav:search")} className="text-[var(--text)] hover:text-[var(--text-dim)] transition-colors">
            <SearchIcon />
          </Link>
          <Link to="/account" aria-label={t("nav:account")} className="rounded-full focus:outline-none focus:ring-2 focus:ring-[var(--accent)]">
            <Avatar name={profile?.name ?? "?"} src={profile?.avatar ?? undefined} size={32} />
          </Link>
        </div>
      </nav>
    </header>
  );
}
