export interface SimItem {
  genres: string[];
  keywords: string[];
  cast: string[];
  director?: string;
  year?: number | null;
  runtimeSec?: number | null;
  rating?: string | null;
  tmdbScore?: number | null;
  imdbRating?: number | null;
  rtRating?: number | null;
  metacritic?: number | null;
}

export interface SimilarRankItem extends SimItem {
  id: string;
  vectorScore?: number | null;
}

export interface RankedSimilarItem {
  id: string;
  score: number;
  contentScore: number;
  vectorScore?: number;
}

const EPSILON = 1e-9;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normaliseToken(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normaliseList(values: string[]): string[] {
  return values.map(normaliseToken).filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(normaliseList(a));
  const setB = new Set(normaliseList(b));
  if (setA.size === 0 && setB.size === 0) return 0;
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
    a.director !== undefined &&
    b.director !== undefined &&
    normaliseToken(a.director) === normaliseToken(b.director)
      ? 1
      : 0;

  const result =
    0.4 * genreScore +
    0.3 * keywordScore +
    0.2 * castScore +
    0.1 * directorScore;

  return clamp01(result);
}

/** Normalized editorial quality signal from locally cached provider ratings. */
export function qualityScore(item: Pick<SimItem, "tmdbScore" | "imdbRating" | "rtRating" | "metacritic">): number {
  const scores: number[] = [];
  if (item.imdbRating != null && Number.isFinite(item.imdbRating)) {
    scores.push(clamp01(item.imdbRating / 10));
  }
  if (item.tmdbScore != null && Number.isFinite(item.tmdbScore)) {
    scores.push(clamp01(item.tmdbScore / 10));
  }
  if (item.rtRating != null && Number.isFinite(item.rtRating)) {
    scores.push(clamp01(item.rtRating / 100));
  }
  if (item.metacritic != null && Number.isFinite(item.metacritic)) {
    scores.push(clamp01(item.metacritic / 100));
  }

  if (scores.length === 0) return 0.55;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function numericAffinity(a: number | null | undefined, b: number | null | undefined, span: number): number | undefined {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return clamp01(1 - Math.abs(a - b) / span);
}

function ratingAffinity(a: string | null | undefined, b: string | null | undefined): number | undefined {
  if (!a || !b) return undefined;
  return normaliseToken(a) === normaliseToken(b) ? 1 : 0.4;
}

function metadataAffinity(anchor: SimItem, candidate: SimItem): number {
  const parts: { score: number; weight: number }[] = [];
  const year = numericAffinity(anchor.year, candidate.year, 25);
  if (year !== undefined) parts.push({ score: year, weight: 0.45 });
  const runtime = numericAffinity(anchor.runtimeSec, candidate.runtimeSec, 3_600);
  if (runtime !== undefined) parts.push({ score: runtime, weight: 0.35 });
  const rating = ratingAffinity(anchor.rating, candidate.rating);
  if (rating !== undefined) parts.push({ score: rating, weight: 0.2 });

  if (parts.length === 0) return 0.5;
  const weight = parts.reduce((sum, part) => sum + part.weight, 0);
  return parts.reduce((sum, part) => sum + part.score * part.weight, 0) / weight;
}

function maxSimilarityToSelected(
  item: SimilarRankItem,
  selected: SimilarRankItem[],
): number {
  let best = 0;
  for (const other of selected) {
    const score = itemSimilarity(item, other);
    if (score > best) best = score;
  }
  return best;
}

export function rankSimilarItems(input: {
  anchor: SimilarRankItem;
  candidates: SimilarRankItem[];
  limit?: number;
  diversityPenalty?: number;
  minRelatedness?: number;
}): RankedSimilarItem[] {
  const {
    anchor,
    candidates,
    limit = 12,
    diversityPenalty = 0.12,
    minRelatedness = 0.05,
  } = input;

  const pool = candidates
    .filter((candidate) => candidate.id !== anchor.id)
    .map((candidate) => {
      const contentScore = itemSimilarity(anchor, candidate);
      const rawVector =
        candidate.vectorScore != null && Number.isFinite(candidate.vectorScore)
          ? clamp01(candidate.vectorScore)
          : undefined;
      const relatedness = Math.max(contentScore, rawVector ?? 0);
      const metadataScore = metadataAffinity(anchor, candidate);
      const editorialScore = qualityScore(candidate);
      const score =
        rawVector !== undefined
          ? 0.42 * rawVector + 0.38 * contentScore + 0.12 * metadataScore + 0.08 * editorialScore
          : 0.68 * contentScore + 0.2 * metadataScore + 0.12 * editorialScore;

      return {
        item: candidate,
        ranked: {
          id: candidate.id,
          score: clamp01(score),
          contentScore,
          ...(rawVector !== undefined ? { vectorScore: rawVector } : {}),
        },
        relatedness,
      };
    })
    .filter((entry) => entry.relatedness >= minRelatedness)
    .sort(
      (a, b) =>
        b.ranked.score - a.ranked.score ||
        b.ranked.contentScore - a.ranked.contentScore ||
        a.ranked.id.localeCompare(b.ranked.id),
    );

  const selected: typeof pool = [];
  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestAdjusted = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const entry = pool[i]!;
      const diversityCost = diversityPenalty * maxSimilarityToSelected(
        entry.item,
        selected.map((s) => s.item),
      );
      const adjusted = entry.ranked.score - diversityCost;
      const best = pool[bestIndex]!;
      if (
        adjusted > bestAdjusted + EPSILON ||
        (Math.abs(adjusted - bestAdjusted) <= EPSILON &&
          (entry.ranked.score > best.ranked.score ||
            (entry.ranked.score === best.ranked.score && entry.ranked.id.localeCompare(best.ranked.id) < 0)))
      ) {
        bestAdjusted = adjusted;
        bestIndex = i;
      }
    }
    const [next] = pool.splice(bestIndex, 1);
    if (next) selected.push(next);
  }

  return selected.map((entry) => entry.ranked);
}
