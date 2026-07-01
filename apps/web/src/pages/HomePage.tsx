import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import { useHomeRows } from "@/lib/queries";
import HomeRows from "@/components/HomeRows";
import SpotlightRow from "@/components/spotlight/SpotlightRow";

export default function HomePage() {
  const { t } = useTranslation();
  const { data, isLoading } = useHomeRows();
  const rows = data?.rows ?? [];

  // Featured row = Continue Watching when present, else the first row.
  const featured = rows.find((r) => r.key === "continue") ?? rows[0];
  const rest = rows.filter((r) => r !== featured);
  const hasFeatured = !!featured && featured.items.length > 0;

  if (isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  return (
    // Pull the spotlight up under the fixed transparent TopNav (cancels
    // AppShell's pt-14) so the gradient bar overlays the backdrop art.
    <div className={cn("flex flex-col gap-6 pb-4", hasFeatured && "-mt-14")}>
      {hasFeatured && <SpotlightRow items={featured.items} />}
      <HomeRows rows={rest} />
    </div>
  );
}
