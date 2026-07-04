import { cn } from "../cn";
import { focusRing } from "../styles";
import type { SelectHTMLAttributes } from "react";

// Chevron in --text-dim (#9aa3b2), inlined so it works offline with no asset request.
const CHEVRON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='16'%20height='16'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='%239aa3b2'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='m6%209%206%206%206-6'/%3E%3C/svg%3E";

type Props = SelectHTMLAttributes<HTMLSelectElement>;

/** Native <select> styled to match Input, with a consistent custom chevron. */
export function Select({ className, style, ...rest }: Props) {
  return (
    <select
      className={cn(
        "appearance-none bg-[var(--surface)] border border-[var(--surface-2)] rounded-[var(--radius-sm)]",
        "px-3 py-2 pr-9 text-[var(--text)]",
        "bg-no-repeat [background-position:right_0.6rem_center] [background-size:1rem]",
        focusRing,
        "disabled:opacity-50",
        className,
      )}
      style={{ backgroundImage: `url("${CHEVRON}")`, ...style }}
      {...rest}
    />
  );
}
