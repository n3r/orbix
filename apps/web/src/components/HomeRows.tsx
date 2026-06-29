"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import MediaRow from "./MediaRow";

interface MediaCard {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
}

interface HomeRow {
  key: string;
  title: string;
  items: MediaCard[];
}

export default function HomeRows() {
  const [rows, setRows] = useState<HomeRow[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch("/home/rows");
        if (!res.ok) return;
        const data = (await res.json()) as { rows: HomeRow[] };
        setRows(data.rows ?? []);
      } catch {
        // Silently ignore — rows just don't render
      }
    })();
  }, []);

  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((row) => (
        <MediaRow key={row.key} title={row.title} items={row.items} />
      ))}
    </>
  );
}
