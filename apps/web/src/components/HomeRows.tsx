import MediaRow from "./MediaRow";
import type { HomeRow } from "@/lib/types";

/** Presentational — rows are fetched client-side and passed in. */
export default function HomeRows({ rows }: { rows: HomeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <MediaRow key={row.key} rowKey={row.key} title={row.title} items={row.items} />
      ))}
    </div>
  );
}
