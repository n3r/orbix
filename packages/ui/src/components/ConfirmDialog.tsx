import { useId } from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn";
import { Button } from "./Button";
import { useFocusTrap } from "../hooks/useFocusTrap";

type Props = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Style the confirm button as destructive (red) and label the dialog accordingly. */
  destructive?: boolean;
  /** Disable the buttons while the action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Accessible confirmation dialog for irreversible actions. Portals to <body>,
 * traps focus, closes on Escape / backdrop click, and names the consequence in
 * the body copy. Use before every destructive action (delete, wipe).
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const titleId = useId();
  const descId = useId();
  const ref = useFocusTrap<HTMLDivElement>(open, { onEscape: busy ? undefined : onCancel });

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-hidden="true"
        onClick={busy ? undefined : onCancel}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          "relative w-full max-w-md rounded-[var(--radius)] border border-[var(--surface-2)]",
          "bg-[var(--surface)] p-6 shadow-2xl",
        )}
      >
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-2 text-sm leading-relaxed text-[var(--text-dim)]">
            {description}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
