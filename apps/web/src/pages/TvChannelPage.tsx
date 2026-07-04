import { useState } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button, cn } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { useTvChannel, useTvProgrammes } from "@/lib/queries";
import { formatTvTime, tvDayString } from "@/lib/tv-time";
import LiveTvOverlay from "@/components/tv/LiveTvOverlay";
import { channelHue, channelInitials, regionName } from "@/lib/tv";
import { HeartIcon, PlayIcon } from "@/components/shell/icons";

/** Channel detail: hero, badges, favorite toggle, Watch CTA, day schedule. */
export default function TvChannelPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const channel = useTvChannel(id);
  const [dayOffset, setDayOffset] = useState<0 | 1>(0);
  const day = tvDayString(dayOffset);
  const programmes = useTvProgrammes(id, day);
  const [watching, setWatching] = useState(false);

  if (channel.isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  const c = channel.data;
  if (!c) return <div className="p-8 text-[var(--text-dim)]">{t("tv:channel.notFound")}</div>;

  const toggleFavorite = async () => {
    try {
      await apiFetch(`/tv/favorites/${c.id}`, { method: c.favorite ? "DELETE" : "PUT" });
    } catch {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["tv-channel", c.id] });
    void queryClient.invalidateQueries({ queryKey: ["tv-home"] });
    void queryClient.invalidateQueries({ queryKey: ["tv-guide"] });
    void queryClient.invalidateQueries({ queryKey: ["tv-favorites"] });
  };

  const badges = [
    regionName(c.country, i18n.language),
    ...c.categories.map((cat) => cat.charAt(0).toUpperCase() + cat.slice(1)),
  ].filter((x): x is string => Boolean(x));

  const schedule = programmes.data?.programmes ?? [];
  // Single snapshot for the whole render — every row's on-air check agrees.
  const nowMs = Date.now();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 md:px-8">
      <div className="flex items-center gap-5">
        <span className="grid h-24 w-40 shrink-0 place-items-center overflow-hidden rounded-[var(--radius)] bg-[var(--surface)]">
          {c.logo ? (
            <img src={c.logo} alt="" className="max-h-16 max-w-32 object-contain" />
          ) : (
            <span
              aria-hidden
              className="grid h-full w-full place-items-center text-3xl font-bold text-white/90"
              style={{ backgroundColor: `hsl(${channelHue(c.id)} 45% 28%)` }}
            >
              {channelInitials(c.name)}
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--text-dim)]">{t("tv:channel.number", { number: c.number })}</p>
          <h1 className="truncate text-3xl font-bold text-[var(--text)]">{c.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-dim)]">
            {c.quality && (
              <span className="rounded-sm bg-white/10 px-1.5 py-0.5 font-semibold text-[var(--text)]">
                {c.quality}
              </span>
            )}
            {badges.map((b) => (
              <span key={b} className="rounded-full border border-[var(--surface-2)] px-2 py-0.5">
                {b}
              </span>
            ))}
            {!c.healthy && <span className="text-zinc-500">● {t("tv:badges.offline")}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void toggleFavorite()}
          aria-label={c.favorite ? t("tv:card.unfavorite") : t("tv:card.favorite")}
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[var(--surface-2)] transition-colors",
            c.favorite ? "text-[var(--accent)]" : "text-[var(--text-dim)] hover:text-[var(--text)]",
          )}
        >
          <HeartIcon className={cn("h-5 w-5", c.favorite && "fill-current")} />
        </button>
      </div>

      <div>
        <Button onClick={() => setWatching(true)}>
          <PlayIcon className="mr-1 h-4 w-4" /> {t("tv:channel.watch")}
        </Button>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-[var(--text)]">{t("tv:channel.schedule")}</h2>

        <div role="tablist" className="mb-3 flex gap-2">
          <button
            type="button"
            role="tab"
            aria-selected={dayOffset === 0}
            onClick={() => setDayOffset(0)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              dayOffset === 0
                ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]"
                : "border-[var(--surface-2)] text-[var(--text-dim)] hover:text-[var(--text)]",
            )}
          >
            {t("tv:channel.today")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={dayOffset === 1}
            onClick={() => setDayOffset(1)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              dayOffset === 1
                ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]"
                : "border-[var(--surface-2)] text-[var(--text-dim)] hover:text-[var(--text)]",
            )}
          >
            {t("tv:channel.tomorrow")}
          </button>
        </div>

        {schedule.length === 0 ? (
          <p className="text-sm text-[var(--text-dim)]">{t("tv:channel.noSchedule")}</p>
        ) : (
          <ul className="flex flex-col">
            {schedule.map((p) => {
              const onAir = Date.parse(p.start) <= nowMs && nowMs < Date.parse(p.stop);
              return (
                <li
                  key={p.id}
                  className={cn(
                    "flex gap-4 rounded px-2 py-2 text-sm",
                    onAir ? "bg-white/10 ring-1 ring-red-500/60" : "border-b border-[var(--surface)]",
                  )}
                >
                  <span className="w-28 shrink-0 tabular-nums text-[var(--text-dim)]">
                    {formatTvTime(p.start, i18n.language)}–{formatTvTime(p.stop, i18n.language)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-medium text-[var(--text)]">{p.title}</span>
                      {onAir && (
                        <span className="shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                          {t("tv:channel.onNow")}
                        </span>
                      )}
                    </span>
                    {p.description && (
                      <span className="line-clamp-2 block text-xs text-[var(--text-dim)]">{p.description}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {watching && (
        <LiveTvOverlay channels={[c]} initialId={c.id} onClose={() => setWatching(false)} />
      )}
    </main>
  );
}
