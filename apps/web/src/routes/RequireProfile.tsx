import { Navigate, Outlet } from "react-router";
import { ApiError } from "@/lib/api";
import { useSetupStatus, useMyProfile, useLibraries } from "@/lib/queries";
import { decideRedirect } from "./decideRedirect";
import AppShell from "@/components/shell/AppShell";
import { useSyncProfileLanguage } from "@/lib/i18n/useActiveLanguage";

export default function RequireProfile() {
  const setup = useSetupStatus();
  const me = useMyProfile();
  const libs = useLibraries();

  // Apply the active profile's language to the UI as soon as it's known.
  useSyncProfileLanguage(me.data?.language);

  if (setup.isLoading || me.isLoading) {
    return <div className="p-8 text-[var(--text-dim)]">Loading…</div>;
  }

  const authError401 = me.error instanceof ApiError && me.error.status === 401;
  const target = decideRedirect({
    setupComplete: setup.data?.complete,
    authError401,
    profileSelected: !!me.data?.id,
  });
  if (target) return <Navigate to={target} replace />;

  const profile = me.data?.id
    ? {
        id: me.data.id,
        name: me.data.name ?? "",
        avatar: me.data.avatar,
        kind: me.data.kind ?? "standard",
        maturityCap: me.data.maturityCap,
      }
    : null;

  return (
    <AppShell libraries={libs.data ?? []} profile={profile} isKids={me.data?.kind === "kids"}>
      <Outlet />
    </AppShell>
  );
}
