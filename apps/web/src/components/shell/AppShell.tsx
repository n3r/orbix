import TopNav from "./TopNav";
import BottomNav from "./BottomNav";
import type { Profile } from "@/lib/types";

export default function AppShell({
  profile,
  children,
}: {
  profile: Profile | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <TopNav profile={profile} />
      {/* Content flows under the fixed top bar; pt clears it on non-hero pages.
          pb-24 on mobile clears the fixed BottomNav. */}
      <div className="pt-14 pb-24 md:pb-0">{children}</div>
      <BottomNav />
      <footer className="px-6 py-4 pb-28 md:pb-4 md:px-8 text-center text-xs text-[var(--text-dim)]">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </footer>
    </div>
  );
}
