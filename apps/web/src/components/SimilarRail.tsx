import { useQuery } from "@tanstack/react-query";
import { apiJson } from "@/lib/api";
import MediaRow from "@/components/MediaRow";
import type { MediaCard } from "@/lib/types";

/**
 * "More Like This" rail for a title. Fetches /items/:id/similar and renders a
 * MediaRow; renders nothing while loading or when there are no results
 * (MediaRow already returns null on an empty list).
 */
export default function SimilarRail({ itemId }: { itemId: string }) {
  const { data } = useQuery({
    queryKey: ["similar", itemId],
    queryFn: () => apiJson<{ items: MediaCard[] }>(`/items/${itemId}/similar`),
    retry: false,
  });
  if (!data || data.items.length === 0) return null;
  return <MediaRow title="More Like This" items={data.items} />;
}
