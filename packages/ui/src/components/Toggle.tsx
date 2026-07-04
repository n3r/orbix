import { cn } from "../cn";
import { focusRing } from "../styles";

type Props = {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/**
 * Accessible on/off switch (role="switch"). Use for boolean settings instead of
 * a bare checkbox where an immediate-apply toggle reads better.
 */
export function Toggle({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  ...aria
}: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      id={id}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]",
        focusRing,
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...aria}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
