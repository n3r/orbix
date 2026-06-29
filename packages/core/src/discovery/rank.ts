/**
 * Cosine similarity and vector-ranking utilities.
 * Pure functions — no I/O, no side effects.
 */

/**
 * Compute the cosine similarity between two numeric vectors.
 * Returns a value in [-1, 1].
 * Returns 0 if the vectors have different lengths or either has zero magnitude.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rank candidates by cosine similarity to a query vector.
 * Sorts by score DESC; ties broken by id ASC (lexicographic).
 * Returns the top `k` results as `{ id, score }`.
 */
export function rankByVector(
  queryVec: number[],
  candidates: { id: string; vector: number[] }[],
  k: number
): { id: string; score: number }[] {
  const scored = candidates.map((c) => ({
    id: c.id,
    score: cosine(queryVec, c.vector),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score; // DESC by score
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;   // ASC by id tiebreak
  });

  return scored.slice(0, k);
}
