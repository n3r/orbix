import { cn } from "../cn";
import { focusRing } from "../styles";
import type { InputHTMLAttributes } from "react";

type Props = InputHTMLAttributes<HTMLInputElement>;

/**
 * Native checkbox tinted with the orbit accent, so every checkbox in the app
 * shares one look instead of the OS-blue default. Wrap in a padded <label> to
 * reach a 44px hit target.
 */
export function Checkbox({ className, ...rest }: Props) {
  return (
    <input
      type="checkbox"
      className={cn(
        "h-[18px] w-[18px] shrink-0 cursor-pointer rounded accent-[var(--accent)]",
        focusRing,
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}
