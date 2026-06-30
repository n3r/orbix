import { cookies } from "next/headers";
import HomeRows, { type HomeRow } from "@/components/HomeRows";
import Hero, { type HeroItem } from "@/components/Hero";

// Reads cookies + per-request authed API calls. Auth gate lives in the layout.
export const dynamic = "force-dynamic";

const BASE =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:1061";

export default async function HomePage() {
  const jar = await cookies();
  const session = jar.get("orbix_session");
  const profile = jar.get("orbix_profile");
  // The (app) layout already guarantees these exist before rendering.
  const cookie = `orbix_session=${session?.value ?? ""}; orbix_profile=${profile?.value ?? ""}`;

  const { rows } = (await fetch(`${BASE}/home/rows`, {
    headers: { cookie },
    cache: "no-store",
  })
    .then((r) => (r.ok ? r.json() : { rows: [] }))
    .catch(() => ({ rows: [] }))) as { rows: HomeRow[] };

  // Build the featured hero from the top items (prefer Continue Watching),
  // fetching detail for backdrop + overview which /home/rows doesn't include.
  const firstRow = rows.find((r) => r.key === "continue_watching") ?? rows[0];
  const candIds = (firstRow?.items ?? []).slice(0, 6).map((i) => i.id);
  const details = await Promise.all(
    candIds.map((id) =>
      fetch(`${BASE}/items/${id}`, { headers: { cookie }, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ),
  );
  const heroItems: HeroItem[] = details
    .filter((d): d is NonNullable<typeof d> => Boolean(d && d.backdropPath))
    .slice(0, 5)
    .map((d) => ({
      id: d.id,
      title: d.title,
      year: d.year,
      overview: d.overview,
      backdropPath: d.backdropPath,
      rating: d.rating,
    }));

  return (
    <div className="flex flex-col gap-6 pb-4">
      {heroItems.length > 0 && <Hero items={heroItems} />}
      {/* MediaRow self-pads (px-6/8/10) so rows are full-bleed within main. */}
      <HomeRows rows={rows} />
    </div>
  );
}
