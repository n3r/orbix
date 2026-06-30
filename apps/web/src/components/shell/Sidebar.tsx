import { Link, useLocation } from "react-router";
import { Avatar, cn } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import type { Library, Profile } from "@/lib/types";

interface SidebarProps {
  libraries: Library[];
  profile: Profile | null;
  isKids: boolean;
  className?: string;
  onNavigate?: () => void;
}

function NavLink({
  href,
  active,
  onNavigate,
  children,
}: {
  href: string;
  active: boolean;
  onNavigate?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors",
        active
          ? "bg-[var(--surface-2)] text-[var(--text)]"
          : "text-[var(--text-dim)] hover:bg-[var(--surface-2)]/50 hover:text-[var(--text)]",
      )}
    >
      {children}
    </Link>
  );
}

// ── tiny inline icons (no icon dependency) ──────────────────────────────────
const ico = "h-4 w-4 shrink-0";
const HomeIcon = () => (
  <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
  </svg>
);
const SearchIcon = () => (
  <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
  </svg>
);
const FilmIcon = () => (
  <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  </svg>
);
const GearIcon = () => (
  <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.61.74 1.04 1.41 1.09H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
);
const LibraryIcon = () => (
  <svg className={ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" />
  </svg>
);

export default function Sidebar({
  libraries,
  profile,
  isKids,
  className,
  onNavigate,
}: SidebarProps) {
  const { pathname } = useLocation();
  const multiLib = libraries.length > 1;

  async function handleLogout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Ignore — navigate regardless so the user isn't stuck.
    }
    // Full reload so cleared cookies take effect and the gate re-runs.
    window.location.href = "/login";
  }

  return (
    <nav
      className={cn(
        "flex flex-col gap-1 overflow-y-auto border-r border-[var(--surface-2)] bg-[var(--surface)] p-3",
        className,
      )}
    >
      {/* Wordmark */}
      <Link
        to="/"
        onClick={onNavigate}
        className="px-2 py-3 text-xl font-bold text-[var(--text)]"
      >
        Orbix
      </Link>

      {/* Primary */}
      <NavLink href="/" active={pathname === "/"} onNavigate={onNavigate}>
        <HomeIcon /> Home
      </NavLink>
      <NavLink href="/search" active={pathname === "/search"} onNavigate={onNavigate}>
        <SearchIcon /> Search
      </NavLink>

      {/* Library nav tree */}
      {libraries.length > 0 && (
        <>
          <p className="px-3 pt-4 pb-1 text-xs uppercase tracking-wide text-[var(--text-dim)]">
            Library
          </p>
          {libraries.map((lib) => (
            <div key={lib.id} className="flex flex-col gap-1">
              {multiLib && (
                <p className="flex items-center gap-2 px-3 pt-2 text-xs text-[var(--text-dim)]">
                  <LibraryIcon /> {lib.name}
                </p>
              )}
              {lib.sections.map((section) => (
                <NavLink
                  key={section.id}
                  href={`/library/${section.id}`}
                  active={pathname === `/library/${section.id}`}
                  onNavigate={onNavigate}
                >
                  <FilmIcon /> {section.name}
                </NavLink>
              ))}
            </div>
          ))}
        </>
      )}

      {/* Admin — hidden for kids profiles */}
      {!isKids && (
        <>
          <p className="px-3 pt-4 pb-1 text-xs uppercase tracking-wide text-[var(--text-dim)]">
            Admin
          </p>
          <NavLink
            href="/admin/libraries"
            active={pathname.startsWith("/admin/libraries")}
            onNavigate={onNavigate}
          >
            <LibraryIcon /> Manage
          </NavLink>
          <NavLink
            href="/admin/settings"
            active={pathname.startsWith("/admin/settings")}
            onNavigate={onNavigate}
          >
            <GearIcon /> Settings
          </NavLink>
        </>
      )}

      {/* Profile footer */}
      <div className="mt-auto flex flex-col gap-2 border-t border-[var(--surface-2)] pt-3">
        {profile && (
          <div className="flex items-center gap-3 px-2">
            <Avatar name={profile.name} src={profile.avatar ?? undefined} size={32} />
            <span className="min-w-0 truncate text-sm text-[var(--text)]">
              {profile.name}
            </span>
          </div>
        )}
        <Link
          to="/profiles"
          onClick={onNavigate}
          className="px-3 py-1.5 text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
        >
          Switch profile
        </Link>
        <button
          type="button"
          onClick={handleLogout}
          className="px-3 py-1.5 text-left text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
        >
          Log out
        </button>
      </div>
    </nav>
  );
}
