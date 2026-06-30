import MediaRow from "./MediaRow";
import type { MediaCard } from "@/lib/types";

export interface HomeRow {
  key: string;
  title: string;
  items: MediaCard[];
}

/** Presentational — rows are fetched server-side and passed in. */
export default function HomeRows({ rows }: { rows: HomeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <MediaRow key={row.key} title={row.title} items={row.items} />
      ))}
    </div>
  );
}
