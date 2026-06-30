import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@orbix/ui";
import { useMenuConfig, saveMenu } from "@/lib/queries";
import type { MenuItem } from "@/lib/types";
import { moveItem } from "./menu-order";

export default function ProfileMenuEditor() {
  const { data, isLoading } = useMenuConfig();
  const qc = useQueryClient();
  const [order, setOrder] = useState<string[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed local state from the loaded config once.
  const byId = useMemo(() => new Map((data?.sections ?? []).map((s) => [s.sectionId, s])), [data]);
  if (data && order === null) {
    // All section ids, enabled-first in saved order, then the rest in default order.
    const rest = data.sections.map((s) => s.sectionId).filter((id) => !data.enabled.includes(id));
    setOrder([...data.enabled, ...rest]);
    setEnabled(new Set(data.enabled));
  }

  if (isLoading || !data || order === null || enabled === null) {
    return <p className="text-[var(--text-dim)]">Loading…</p>;
  }

  const toggle = (id: string) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id); else next.add(id);
    setEnabled(next);
    setSaved(false);
  };
  const move = (index: number, dir: -1 | 1) => { setOrder(moveItem(order, index, dir)); setSaved(false); };

  async function onSave() {
    setSaving(true);
    setSaved(false);
    try {
      const sectionIds = order!.filter((id) => enabled!.has(id));
      await saveMenu(sectionIds);
      await qc.invalidateQueries({ queryKey: ["menu"] });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p className="text-sm text-[var(--text-dim)]">
        Choose which categories show in your menu and put them in order.
      </p>
      <ul className="flex flex-col gap-1">
        {order.map((id, index) => {
          const section = byId.get(id) as MenuItem | undefined;
          if (!section) return null;
          return (
            <li key={id} className="flex items-center gap-3 rounded-[var(--radius-sm)] bg-[var(--surface)] px-3 py-2">
              <input
                id={`sec-${id}`}
                type="checkbox"
                checked={enabled.has(id)}
                onChange={() => toggle(id)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <label htmlFor={`sec-${id}`} className="flex-1 text-sm text-[var(--text)]">
                {section.name}
                <span className="ml-2 text-xs text-[var(--text-dim)]">{section.libraryName}</span>
              </label>
              <div className="flex gap-1">
                <button type="button" aria-label={`Move ${section.name} up`} disabled={index === 0}
                  onClick={() => move(index, -1)} className="px-2 text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30">↑</button>
                <button type="button" aria-label={`Move ${section.name} down`} disabled={index === order.length - 1}
                  onClick={() => move(index, 1)} className="px-2 text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30">↓</button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save menu"}</Button>
        {saved && <span className="text-sm text-[var(--text-dim)]">Saved.</span>}
      </div>
    </div>
  );
}
