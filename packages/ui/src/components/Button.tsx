import { cn } from "../cn";
import { focusRing } from "../styles";
import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};

const VARIANTS: Record<NonNullable<Props["variant"]>, string> = {
  primary: "bg-[var(--accent)] text-white hover:opacity-90",
  ghost: "bg-transparent text-[var(--text-dim)] hover:text-[var(--text)]",
  danger: "bg-[var(--danger)] text-white hover:bg-[var(--danger-strong)]",
};

export function Button({ variant = "primary", className, ...rest }: Props) {
  return (
    <button
      type="button"
      className={cn(
        // min-h-11 keeps every button at a 44px touch target.
        "inline-flex min-h-11 items-center justify-center px-4 py-2 rounded-[var(--radius-sm)]",
        "font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
        focusRing,
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}
