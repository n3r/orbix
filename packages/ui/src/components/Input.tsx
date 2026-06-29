import { cn } from "../cn";
import type { InputHTMLAttributes } from "react";

type Props = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...rest }: Props) {
  return (
    <input
      className={cn(
        "bg-[var(--surface)] border border-[var(--surface-2)] rounded-[var(--radius-sm)]",
        "px-3 py-2 text-[var(--text)] placeholder:text-[var(--text-dim)]",
        "focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent",
        "disabled:opacity-50",
        className
      )}
      {...rest}
    />
  );
}
