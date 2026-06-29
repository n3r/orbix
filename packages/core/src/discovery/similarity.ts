export interface SimItem {
  genres: string[];
  keywords: string[];
  cast: string[];
  director?: string;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function itemSimilarity(a: SimItem, b: SimItem): number {
  const genreScore = jaccard(a.genres, b.genres);
  const keywordScore = jaccard(a.keywords, b.keywords);
  const castScore = jaccard(a.cast, b.cast);
  const directorScore =
    a.director !== undefined && a.director === b.director ? 1 : 0;

  const result =
    0.4 * genreScore +
    0.3 * keywordScore +
    0.2 * castScore +
    0.1 * directorScore;

  return Math.min(1, Math.max(0, result));
}
