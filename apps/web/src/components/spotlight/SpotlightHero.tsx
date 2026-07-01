import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@orbix/ui";
import type { HomeCard, TitleDetail } from "@/lib/types";
import BadgeStack from "./BadgeStack";
import { isNew, progressPct, resumeLabel, timeLeftLabel } from "@/lib/spotlight";

/** The large hero for the active spotlight item. Fixed-size slot; content swaps. */
export default function SpotlightHero({
  card,
  detail,
}: {
  card: HomeCard;
  detail: TitleDetail | undefined;
}) {
  const { t } = useTranslation();

  const isContinue = !!(card.resume || card.progress);
  const resume = resumeLabel(card.resume);
  const pct = card.progress ? progressPct(card.progress.positionSec, card.progress.durationSec) : 0;
  const timeLeft = card.progress
    ? timeLeftLabel(card.progress.positionSec, card.progress.durationSec)
    : null;

  const metaLine = isContinue
    ? null
    : [
        detail?.genres?.[0],
        card.year ?? detail?.year ?? null,
        detail?.seasons && detail.seasons.length > 0 ? `${detail.seasons.length} Seasons` : null,
        detail?.rating,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <section className="relative aspect-video w-full overflow-hidden rounded-[var(--radius)] bg-[var(--surface)]">
      {detail?.backdropPath && (
        <img
          key={detail.id}
          src={`/api/images/${detail.backdropPath}`}
          alt=""
          className="absolute inset-0 h-full w-full animate-[fadein_300ms_ease] object-cover motion-reduce:animate-none"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/30 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg)]/80 via-transparent to-transparent" />

      <BadgeStack
        isNew={isNew(card.addedAt, new Date())}
        className="absolute right-3 top-3"
      />

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-4 md:p-6">
        {detail ? (
          <>
            {detail.logoPath ? (
              <img
                src={`/api/images/${detail.logoPath}`}
                alt={card.title}
                className="max-h-20 w-auto max-w-[60%] object-contain md:max-h-28"
              />
            ) : (
              <h2 className="text-2xl font-bold text-[var(--text)] md:text-4xl">{card.title}</h2>
            )}

            {isContinue ? (
              <div className="flex max-w-xl flex-col gap-1">
                {resume && <span className="text-sm text-[var(--text-dim)]">{resume}</span>}
                {card.progress && (
                  <div className="flex items-center gap-3">
                    <span className="h-1 w-40 overflow-hidden rounded bg-[var(--surface-2)]">
                      <span className="block h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                    </span>
                    {timeLeft && <span className="text-xs text-[var(--text-dim)]">{timeLeft}</span>}
                  </div>
                )}
              </div>
            ) : (
              <>
                {metaLine && (
                  <div className="text-sm text-[var(--text-dim)]">{metaLine}</div>
                )}
                {detail.overview && (
                  <p className="line-clamp-2 max-w-xl text-sm text-[var(--text-dim)] md:line-clamp-3">
                    {detail.overview}
                  </p>
                )}
              </>
            )}

            <div className="mt-1 flex items-center gap-3">
              <Link to={`/title/${card.id}`}>
                <Button>▶ {t("catalog:hero.play")}</Button>
              </Link>
              <Link to={`/title/${card.id}`}>
                <Button variant="ghost">{t("catalog:hero.moreInfo")}</Button>
              </Link>
            </div>
          </>
        ) : (
          <div className={cn("h-24 w-2/3 animate-pulse rounded bg-[var(--surface-2)]")} />
        )}
      </div>
    </section>
  );
}
