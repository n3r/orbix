import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import { useToggleTvFavorite } from "@/lib/queries";
import type { TvChannelCard } from "@/lib/types";
import { HeartIcon } from "@/components/shell/icons";
import { NowProgressBar } from "./NowProgressBar";
import { ChannelLogo } from "./ChannelLogo";

/**
 * 16:9 channel tile: cached logo centered on a dark surface (deterministic
 * hue-hashed gradient monogram fallback), number + name scrim, quality chip,
 * grey offline dot, hover favorite heart. The whole tile is the play button;
 * the heart is a positioned sibling painted above it (no nested buttons).
 */
export default function ChannelCard({
  channel,
  onPlay,
  className,
}: {
  channel: TvChannelCard;
  onPlay: (channel: TvChannelCard) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const toggleFavorite = useToggleTvFavorite();

  return (
    <div
      className={cn(
        "group relative block shrink-0 snap-start overflow-hidden rounded-md bg-[var(--surface)]",
        "transition-transform delay-75 duration-200 hover:z-10 hover:scale-[1.06] hover:shadow-xl hover:shadow-black/50",
        "motion-reduce:transition-none motion-reduce:hover:transform-none",
        className,
      )}
    >
      {/* Art + name scrim dim together when the channel is offline; the
          status dot (a later sibling below) stays at full strength so the
          reason for the dimming is still legible. */}
      <div className={cn(!channel.healthy && "opacity-50")}>
        <ChannelLogo
          logo={channel.logo}
          name={channel.name}
          channelId={channel.id}
          className="aspect-video w-full"
          imgClassName="max-h-[55%] max-w-[70%]"
          monogramClassName="text-2xl font-semibold uppercase tracking-wide text-white/90"
          gradient
          loading="lazy"
        />

        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2.5 pb-2 pt-6">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] tabular-nums text-white/60">{channel.number}</span>
            <span className="line-clamp-1 flex-1 text-[13px] font-medium leading-tight text-white">
              {channel.name}
            </span>
            {channel.quality && (
              <span className="rounded-sm bg-white/15 px-1 py-0.5 text-[10px] font-semibold leading-none text-white/90">
                {channel.quality}
              </span>
            )}
          </div>
          {/* now-playing — cards stay clean without EPG (no label when null) */}
          {channel.now && (
            <div className="min-w-0">
              <p className="line-clamp-1 text-[11px] text-white/70">{channel.now.title}</p>
              <NowProgressBar start={channel.now.start} stop={channel.now.stop} />
            </div>
          )}
        </div>
      </div>

      {!channel.healthy && (
        <span
          title={t("tv:badges.offline")}
          aria-label={t("tv:badges.offline")}
          className="absolute left-1.5 top-1.5 h-2 w-2 rounded-full bg-zinc-500"
        />
      )}

      {/* Primary action: the whole tile tunes the channel. */}
      <button
        type="button"
        onClick={() => onPlay(channel)}
        aria-label={t("tv:card.play", { name: channel.name })}
        className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />

      {/* Favorite heart — painted above the play hit-area (later sibling). */}
      <button
        type="button"
        onClick={() => toggleFavorite.mutate({ channelId: channel.id, isFavorite: channel.favorite })}
        aria-label={channel.favorite ? t("tv:card.unfavorite") : t("tv:card.favorite")}
        className={cn(
          "absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/50 text-white",
          "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
          channel.favorite && "opacity-100 text-[var(--accent)]",
        )}
      >
        <HeartIcon className={cn("h-4 w-4", channel.favorite && "fill-current")} />
      </button>
    </div>
  );
}
