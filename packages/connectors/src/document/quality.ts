import type { RecognitionLevel, RecognitionQuality } from './types.js';

export function recognitionLevel(score: number): RecognitionLevel {
  if (score >= 0.85) return 'high';
  if (score >= 0.70) return 'mid';
  return 'low';
}

export function averageQuality(
  pages: Array<{ page: number; score?: number }>,
): RecognitionQuality {
  const scored = pages.filter(
    (p): p is { page: number; score: number } =>
      typeof p.score === 'number' && Number.isFinite(p.score),
  );
  if (scored.length === 0) {
    return { score: 0, level: 'low', pages: [] };
  }
  const score = scored.reduce((sum, p) => sum + p.score, 0) / scored.length;
  return {
    score,
    level: recognitionLevel(score),
    pages: scored.map((p) => ({
      page: p.page,
      score: p.score,
      level: recognitionLevel(p.score),
    })),
  };
}
