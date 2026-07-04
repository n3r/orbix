import { cn } from "../cn";
import type { HTMLAttributes } from "react";

type Rounded = "sm" | "md" | "lg" | "full" | "none";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** Corner rounding; defaults to the medium token radius. */
  rounded?: Rounded;
};

const RADIUS: Record<Rounded, string> = {
  none: "",
  sm: "rounded-[var(--radius-sm)]",
  md: "rounded-[var(--radius)]",
  lg: "rounded-[var(--radius-lg)]",
  full: "rounded-full",
};

/**
 * Content placeholder. Use instead of a spinner or "Loading…" text so loading
 * states preview the shape of what's coming and the app feels instant.
 * Purely decorative — hidden from assistive tech; announce loading elsewhere.
 */
export function Skeleton({ className, rounded = "md", ...rest }: Props) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse bg-[var(--surface-2)] motion-reduce:animate-none",
        RADIUS[rounded],
        className,
      )}
      {...rest}
    />
  );
}
