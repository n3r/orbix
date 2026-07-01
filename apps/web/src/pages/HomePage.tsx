import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import { apiJson } from "@/lib/api";
import { useHomeRows } from "@/lib/queries";
import HomeRows from "@/components/HomeRows";
import Hero, { type HeroItem } from "@/components/Hero";

export default function HomePage() {
  const { t } = useTranslation();
  const { data, isLoading } = useHomeRows();
  const rows = data?.rows ?? [];

  // Hero candidates: top of Continue Watching (or first row); fetch detail for
  // backdrop + overview, which /home/rows does not include.
  const firstRow = rows.find((r) => r.key === "continue") ?? rows[0];
  const candIds = (firstRow?.items ?? []).slice(0, 6).map((i) => i.id);
  const detailQueries = useQueries({
    queries: candIds.map((id) => ({
      queryKey: ["item", id] as const,
      queryFn: () => apiJson<HeroItem>(`/items/${id}`),
    })),
  });
  const heroItems: HeroItem[] = detailQueries
    .map((q) => q.data)
    .filter((d): d is HeroItem => Boolean(d && d.backdropPath))
    .slice(0, 5);

  if (isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  return (
    // When a hero is shown, pull it up under the fixed transparent TopNav (it
    // cancels AppShell's pt-14) so the gradient bar overlays the backdrop art.
    <div className={cn("flex flex-col gap-6 pb-4", heroItems.length > 0 && "-mt-14")}>
      {heroItems.length > 0 && <Hero items={heroItems} />}
      {/* MediaRow self-pads (px-6/8/10) so rows are full-bleed within main. */}
      <HomeRows rows={rows} />
    </div>
  );
}
