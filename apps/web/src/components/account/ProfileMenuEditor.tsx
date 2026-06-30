import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@orbix/ui";
import { useMenuConfig, saveMenu } from "@/lib/queries";
import type { MenuItem } from "@/lib/types";
import { moveItem } from "./menu-order";

export default function ProfileMenuEditor() {
  const { t } = useTranslation();
  const { data, isLoading } = useMenuConfig();
  const qc = useQueryClient();
  const [order, setOrder] = useState<string[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed local state from the loaded config once.
  const byId = useMemo(() => new Map((data?.libraries ?? []).map((l) => [l.libraryId, l])), [data]);
  if (data && order === null) {
    // All library ids, enabled-first in saved order, then the rest in default order.
    const rest = data.libraries.map((l) => l.libraryId).filter((id) => !data.enabled.includes(id));
    setOrder([...data.enabled, ...rest]);
    setEnabled(new Set(data.enabled));
  }

  if (isLoading || !data || order === null || enabled === null) {
    return <p className="text-[var(--text-dim)]">{t("common:status.loading")}</p>;
  }

  const toggle = (id: string) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id); else next.add(id);
    setEnabled(next);
    setSaved(false);
  };
  const move = (index: number, dir: -1 | 1) => { setOrder(moveItem(order, index, dir)); setSaved(false); };

  const noneEnabled = enabled.size === 0;

  async function onSave() {
    const libraryIds = order!.filter((id) => enabled!.has(id));
    // An empty menu is not representable (it would re-enable everything), so the
    // button is disabled in this state; guard here too for safety.
    if (libraryIds.length === 0) return;
    setSaving(true);
    setSaved(false);
    try {
      await saveMenu(libraryIds);
      await qc.invalidateQueries({ queryKey: ["menu"] });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p className="text-sm text-[var(--text-dim)]">{t("account:menu.intro")}</p>
      <ul className="flex flex-col gap-1">
        {order.map((id, index) => {
          const library = byId.get(id) as MenuItem | undefined;
          if (!library) return null;
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
                {library.name}
              </label>
              <div className="flex gap-1">
                <button type="button" aria-label={t("account:menu.moveUp", { name: library.name })} disabled={index === 0}
                  onClick={() => move(index, -1)} className="px-2 text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30">↑</button>
                <button type="button" aria-label={t("account:menu.moveDown", { name: library.name })} disabled={index === order.length - 1}
                  onClick={() => move(index, 1)} className="px-2 text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30">↓</button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={saving || noneEnabled}>{saving ? t("common:status.saving") : t("account:menu.save")}</Button>
        {noneEnabled && <span className="text-sm text-[var(--text-dim)]">{t("account:menu.selectOne")}</span>}
        {saved && !noneEnabled && <span className="text-sm text-[var(--text-dim)]">{t("account:menu.saved")}</span>}
      </div>
    </div>
  );
}
