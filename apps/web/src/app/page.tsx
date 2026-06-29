import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import HomeRows from "@/components/HomeRows";

// Always dynamic — reads cookies and makes authed API calls per request.
export const dynamic = "force-dynamic";

const BASE =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:1061";

export default async function HomePage() {
  // 1. Check setup status (no auth needed)
  const statusRes = await fetch(`${BASE}/setup/status`, { cache: "no-store" });
  const { complete } = (await statusRes.json()) as { complete: boolean };
  if (!complete) redirect("/setup");

  // 2. Check authentication by forwarding the session cookie
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("orbix_session");
  if (!sessionCookie) redirect("/login");

  const meRes = await fetch(`${BASE}/auth/me`, {
    headers: { cookie: `orbix_session=${sessionCookie.value}` },
    cache: "no-store",
  });
  if (!meRes.ok) redirect("/login");

  // 3. Check profile selection (httpOnly cookie — must read server-side)
  const profileCookie = cookieStore.get("orbix_profile");
  if (!profileCookie) redirect("/profiles");

  // All checks passed — show home
  return (
    <main className="flex min-h-screen flex-col gap-6 pt-8">
      <HomeRows />
    </main>
  );
}
