import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import type { MenuItem } from "@/lib/types";
import { ChevronDownIcon } from "./icons";

function CategoryLink({ item, active, onNavigate }: { item: MenuItem; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={`/library/${item.sectionId}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "whitespace-nowrap text-sm transition-colors",
        active ? "text-[var(--text)] font-medium" : "text-[var(--text-dim)] hover:text-[var(--text)]",
      )}
    >
      {item.name}
    </Link>
  );
}

export default function NavCategories({
  items,
  pathname,
  maxVisible = 6,
  onNavigate,
}: {
  items: MenuItem[];
  pathname: string;
  maxVisible?: number;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const isActive = (id: string) => pathname === `/library/${id}`;
  const visible = items.slice(0, maxVisible);
  const overflow = items.slice(maxVisible);

  return (
    <div className="flex items-center gap-4">
      {visible.map((item) => (
        <CategoryLink key={item.sectionId} item={item} active={isActive(item.sectionId)} onNavigate={onNavigate} />
      ))}
      {overflow.length > 0 && (
        <details className="relative">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-sm text-[var(--text-dim)] hover:text-[var(--text)]">
            {t("nav:more")} <ChevronDownIcon />
          </summary>
          <div className="absolute right-0 z-50 mt-2 flex min-w-40 flex-col gap-1 rounded-[var(--radius)] border border-[var(--surface-2)] bg-[var(--surface)] p-2 shadow-lg">
            {overflow.map((item) => (
              <CategoryLink key={item.sectionId} item={item} active={isActive(item.sectionId)} onNavigate={onNavigate} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
