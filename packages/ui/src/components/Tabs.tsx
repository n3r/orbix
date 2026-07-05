import { useRef, type KeyboardEvent } from "react";
import { cn } from "../cn";
import { focusRing } from "../styles";

export interface TabItem {
  value: string;
  label: string;
}

type Props = {
  tabs: TabItem[];
  value: string;
  onValueChange: (next: string) => void;
  className?: string;
  "aria-label"?: string;
};

/**
 * Controlled tab strip (role="tablist") with roving focus and Left/Right
 * arrow activation. Panels live with the caller: render the active panel
 * with `role="tabpanel"` and `aria-labelledby={`tab-${value}`}`.
 */
export function Tabs({ tabs, value, onValueChange, className, ...aria }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const next = (idx + dir + tabs.length) % tabs.length;
    onValueChange(tabs[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      {...aria}
      className={cn(
        "flex w-fit gap-1 rounded-[var(--radius)] bg-[var(--surface)] p-1",
        className,
      )}
    >
      {tabs.map((tab, idx) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.value}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cn(
              "rounded-[var(--radius-sm)] px-4 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-[var(--surface-3)] text-[var(--text)]"
                : "text-[var(--text-dim)] hover:text-[var(--text)]",
              focusRing,
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
