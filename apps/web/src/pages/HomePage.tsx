import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import { useHomeRows } from "@/lib/queries";
import { dailySeed, pickBillboard } from "@/lib/billboard";
import HomeRows from "@/components/HomeRows";
import HomeBillboard from "@/components/billboard/HomeBillboard";

export default function HomePage() {
  const { t } = useTranslation();
  const { data, isLoading } = useHomeRows();
  const rows = data?.rows ?? [];

  // One featured title on the billboard (rotates daily); every row (continue
  // watching included) still renders below it, Netflix-style.
  const featured = pickBillboard(rows, dailySeed());

  if (isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  return (
    // Pull the billboard up under the fixed transparent TopNav (cancels
    // AppShell's pt-14) so the gradient bar overlays the backdrop art.
    <div className={cn("flex flex-col pb-12", featured && "-mt-14")}>
      {featured && <HomeBillboard card={featured} />}
      {/* First row rides up into the billboard's bottom dissolve. */}
      <div className={cn("relative z-10", featured && "-mt-12 md:-mt-20")}>
        <HomeRows rows={rows} />
      </div>
    </div>
  );
}
