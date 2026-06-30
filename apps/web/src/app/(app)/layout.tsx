import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "@/components/shell/AppShell";
import type { Library, Profile } from "@/lib/types";

// Reads cookies + makes per-request authed API calls → must be dynamic.
export const dynamic = "force-dynamic";

const BASE =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:1061";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 1. Setup must be complete (unauthenticated check).
  const { complete } = (await fetch(`${BASE}/setup/status`, {
    cache: "no-store",
  }).then((r) => r.json())) as { complete: boolean };
  if (!complete) redirect("/setup");

  // 2. Session cookie (httpOnly — only readable server-side).
  const jar = await cookies();
  const session = jar.get("orbix_session");
  if (!session) redirect("/login");
  const meRes = await fetch(`${BASE}/auth/me`, {
    headers: { cookie: `orbix_session=${session.value}` },
    cache: "no-store",
  });
  if (!meRes.ok) redirect("/login");

  // 3. A profile must be selected.
  const profileCookie = jar.get("orbix_profile");
  if (!profileCookie) redirect("/profiles");

  // 4. Nav data — forward BOTH cookies; degrade gracefully on failure.
  const cookie = `orbix_session=${session.value}; orbix_profile=${profileCookie.value}`;
  const [libraries, profiles] = await Promise.all([
    fetch(`${BASE}/libraries`, { headers: { cookie }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []) as Promise<Library[]>,
    fetch(`${BASE}/profiles`, { headers: { cookie }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []) as Promise<Profile[]>,
  ]);

  // orbix_profile holds the profile id → resolve the active profile for the
  // sidebar footer and kids gating in one shot (no separate /me/profile call).
  const active = profiles.find((p) => p.id === profileCookie.value) ?? null;

  return (
    <AppShell libraries={libraries} profile={active} isKids={active?.kind === "kids"}>
      {children}
    </AppShell>
  );
}
