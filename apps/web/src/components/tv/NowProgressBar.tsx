import { nowProgressPercent } from "@/lib/tv-time";

/** Thin red elapsed-time bar under a now-playing title (guide rows, cards, OSD). */
export function NowProgressBar({ start, stop }: { start: string; stop: string }) {
  return (
    <div data-progress className="h-0.5 w-full overflow-hidden rounded-full bg-white/20" aria-hidden="true">
      <div
        className="h-full rounded-full bg-red-500"
        style={{ width: `${nowProgressPercent({ start, stop })}%` }}
      />
    </div>
  );
}
