import { useTranslation } from "react-i18next";
import type { TvProgrammeSlot } from "@/lib/types";
import { formatTvTime } from "@/lib/tv-time";
import { NowProgressBar } from "./NowProgressBar";

/**
 * Now/next display shared by the TvGuidePage rows and the LiveTvOverlay
 * mini-guide drawer: now title + time range + elapsed-progress bar, the
 * localized "no guide data" copy when there's no current programme, and a
 * compact next-up line. Kept self-contained (own useTranslation) so both
 * call sites render byte-for-byte the same binding.
 */
export function ChannelNowNext({ now, next }: { now: TvProgrammeSlot | null; next: TvProgrammeSlot | null }) {
  const { t, i18n } = useTranslation();

  return (
    <span className="block min-w-0">
      {now ? (
        <span className="block min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-xs text-[var(--text-dim)]">{now.title}</span>
            <span className="shrink-0 text-[11px] text-[var(--text-dim)]">
              {formatTvTime(now.start, i18n.language)}–{formatTvTime(now.stop, i18n.language)}
            </span>
          </span>
          <div className="mt-1">
            <NowProgressBar start={now.start} stop={now.stop} />
          </div>
        </span>
      ) : (
        <span className="block truncate text-xs text-[var(--text-dim)]">{t("tv:guidePage.noEpg")}</span>
      )}
      {next && (
        <span className="block truncate text-[11px] text-[var(--text-dim)]">
          {t("tv:guidePage.next")} · {formatTvTime(next.start, i18n.language)} {next.title}
        </span>
      )}
    </span>
  );
}
