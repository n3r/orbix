import { cn } from "@orbix/ui";

/** Small overlaid chips: "NEW" and/or a time-left label. Renders nothing when empty. */
export default function BadgeStack({
  isNew,
  timeLeft,
  className,
}: {
  isNew?: boolean;
  timeLeft?: string | null;
  className?: string;
}) {
  if (!isNew && !timeLeft) return null;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {isNew && (
        <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-white">
          NEW
        </span>
      )}
      {timeLeft && (
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-xs text-[var(--text)]">
          {timeLeft}
        </span>
      )}
    </div>
  );
}
