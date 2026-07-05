import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { HomeCard } from "@/lib/types";
import { useItemDetail } from "@/lib/queries";
import { isNew } from "@/lib/spotlight";
import { InfoIcon, PlayIcon } from "@/components/shell/icons";

/**
 * Netflix-style full-bleed billboard for the featured title. Paints
 * immediately from the row card (title + backdrop) and upgrades to logo art,
 * synopsis and the maturity cert once the detail query lands. The bottom
 * gradient dissolves into the page background so the first row can overlap it.
 */
export default function HomeBillboard({ card }: { card: HomeCard }) {
  const { t } = useTranslation();
  const { data: detail } = useItemDetail(card.id);

  const backdrop = detail?.backdropPath ?? card.backdropPath ?? null;
  const logo = detail?.logoPath ?? null;
  const fresh = isNew(card.addedAt, new Date());
  const meta = [
    detail?.genres?.[0],
    card.year ?? detail?.year ?? null,
    detail?.seasons && detail.seasons.length > 0
      ? t("catalog:spotlight.seasons", { count: detail.seasons.length })
      : null,
  ].filter(Boolean);

  return (
    <section aria-label={card.title} className="relative w-full overflow-hidden bg-[var(--bg)]">
      <div className="relative h-[56.25vw] max-h-[85svh] min-h-[26rem] w-full">
        {backdrop && (
          <img
            key={backdrop}
            src={`/api/images/${backdrop}`}
            alt=""
            className="absolute inset-0 h-full w-full animate-[fadein_500ms_ease] object-cover motion-reduce:animate-none"
          />
        )}
        {/* Legibility scrims: top bar for the transparent nav, left vignette
            behind the copy, bottom dissolve into the rows. */}
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/60 via-black/20 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg)]/85 via-[var(--bg)]/25 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/60 to-transparent md:h-60" />

        {/* Copy block, bottom-left like the reference. */}
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-start gap-3 px-[4vw] pb-20 md:gap-4 md:pb-32">
          {logo ? (
            <>
              {/* The logo art IS the title visually; keep a heading for AT and tests. */}
              <h1 className="sr-only">{card.title}</h1>
              <img
                src={`/api/images/${logo}`}
                alt=""
                className="max-h-24 w-auto max-w-[min(28rem,60vw)] object-contain object-left-bottom drop-shadow-xl md:max-h-40"
              />
            </>
          ) : (
            <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight text-[var(--text)] drop-shadow-lg md:text-6xl">
              {card.title}
            </h1>
          )}

          {(fresh || meta.length > 0) && (
            <p className="flex items-center gap-2 text-sm font-medium text-[var(--text)]/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.7)] md:text-base">
              {fresh && (
                <span className="rounded-sm bg-[var(--accent-strong)] px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">
                  {t("catalog:spotlight.new")}
                </span>
              )}
              {meta.join(" · ")}
            </p>
          )}

          {detail?.overview && (
            <p className="line-clamp-3 max-w-xl text-sm text-[var(--text)]/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.8)] md:text-base">
              {detail.overview}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Link
              to={`/title/${card.id}?play=1`}
              className="flex items-center gap-2 rounded bg-white px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:px-7 md:py-2.5 md:text-base"
            >
              <PlayIcon className="h-5 w-5 md:h-6 md:w-6" /> {t("catalog:hero.play")}
            </Link>
            <Link
              to={`/title/${card.id}`}
              className="flex items-center gap-2 rounded bg-white/25 px-5 py-2 text-sm font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:px-7 md:py-2.5 md:text-base"
            >
              <InfoIcon className="h-5 w-5 md:h-6 md:w-6" /> {t("catalog:hero.moreInfo")}
            </Link>
          </div>
        </div>

        {/* Maturity cert plate pinned to the right edge, like the reference.
            Hidden on small screens where it would collide with the buttons. */}
        {detail?.rating && (
          <div className="absolute bottom-32 right-0 z-10 hidden border border-[var(--surface-2)] bg-[var(--surface)]/50 py-1 pl-3 pr-[3vw] text-base font-medium text-[var(--text)]/90 backdrop-blur-sm md:block">
            {detail.rating}
          </div>
        )}
      </div>
    </section>
  );
}
