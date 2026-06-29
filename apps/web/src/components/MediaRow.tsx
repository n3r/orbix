import Link from "next/link";

interface MediaCard {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
}

interface MediaRowProps {
  title: string;
  items: MediaCard[];
}

export default function MediaRow({ title, items }: MediaRowProps) {
  if (items.length === 0) return null;

  return (
    <section className="w-full px-8 py-4">
      <h2 className="text-xl font-semibold text-[var(--text)] mb-3">{title}</h2>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/title/${item.id}`}
            className="flex-shrink-0 w-40 flex flex-col gap-2 group"
          >
            {item.posterPath ? (
              <img
                src={`/api/images/${item.posterPath}`}
                alt={item.title}
                className="w-full aspect-[2/3] object-cover rounded-[var(--radius)] group-hover:opacity-80 transition-opacity"
              />
            ) : (
              <div className="w-full aspect-[2/3] bg-[var(--surface)] rounded-[var(--radius)] flex items-center justify-center">
                <span className="text-[var(--text-dim)] text-xs">No image</span>
              </div>
            )}
            <p className="text-sm text-[var(--text)] truncate">{item.title}</p>
            {item.year && (
              <p className="text-xs text-[var(--text-dim)] -mt-1">{item.year}</p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
