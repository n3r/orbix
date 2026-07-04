import { useTranslation } from "react-i18next";
import { Button, Skeleton, cn } from "@orbix/ui";
import { useHomeRows } from "@/lib/queries";
import { dailySeed, pickBillboard } from "@/lib/billboard";
import HomeRows from "@/components/HomeRows";
import HomeBillboard from "@/components/billboard/HomeBillboard";

// Landscape card widths, kept in sync with MediaRow so the skeleton matches the
// real rails exactly (no layout jump when content arrives).
const CARD_W = "w-[44vw] sm:w-[30vw] md:w-[23.5vw] lg:w-[19vw] xl:w-[15.5vw]";

function HomeSkeleton() {
  return (
    <div className="-mt-14 flex flex-col pb-12">
      <Skeleton rounded="none" className="h-[62vw] max-h-[80vh] w-full" />
      <div className="relative z-10 -mt-12 flex flex-col gap-6 md:-mt-20 md:gap-9">
        {[0, 1, 2].map((row) => (
          <section key={row} className="w-full">
            <Skeleton rounded="sm" className="mb-2 ml-[4vw] h-6 w-40" />
            <div className="flex gap-2 overflow-hidden px-[4vw] py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className={cn("aspect-video shrink-0", CARD_W)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function HomeMessage({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold text-[var(--text)]">{title}</h1>
      <p className="max-w-md text-balance text-[var(--text-dim)]">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export default function HomePage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useHomeRows();
  const rows = data?.rows ?? [];

  if (isLoading) return <HomeSkeleton />;

  if (isError)
    return (
      <HomeMessage
        title={t("catalog:home.errorTitle")}
        body={t("catalog:home.errorBody")}
        action={<Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>}
      />
    );

  if (rows.length === 0)
    return (
      <HomeMessage title={t("catalog:home.emptyTitle")} body={t("catalog:home.emptyBody")} />
    );

  // One featured title on the billboard (rotates daily); every row (continue
  // watching included) still renders below it, Netflix-style.
  const featured = pickBillboard(rows, dailySeed());

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
