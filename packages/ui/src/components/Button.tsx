import { cn } from "../cn";
import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" };

export function Button({ variant = "primary", className, ...rest }: Props) {
  return (
    <button
      className={cn(
        "px-4 py-2 rounded-[var(--radius-sm)] font-medium transition-colors disabled:opacity-50",
        variant === "primary"
          ? "bg-[var(--accent)] text-white hover:opacity-90"
          : "bg-transparent text-[var(--text-dim)] hover:text-[var(--text)]",
        className
      )}
      {...rest}
    />
  );
}
