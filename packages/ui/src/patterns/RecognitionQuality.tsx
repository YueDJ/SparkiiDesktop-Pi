import { useState } from 'react';

export type RecognitionLevel = 'high' | 'mid' | 'low';

export interface RecognitionQualityValue {
  score: number;
  level: RecognitionLevel;
  pages?: Array<{ page: number; score: number; level: RecognitionLevel }>;
}

const LEVEL_LABEL: Record<RecognitionLevel, string> = {
  high: '高',
  mid: '中',
  low: '低',
};

function isRecognitionLevel(value: unknown): value is RecognitionLevel {
  return value === 'high' || value === 'mid' || value === 'low';
}

function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function RecognitionQuality({
  quality,
  engine,
  fileName,
  compact = false,
}: {
  quality?: RecognitionQualityValue;
  engine?: 'native' | 'structure';
  fileName?: string;
  compact?: boolean;
}) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const native = engine === 'native';
  const hasQuality = Boolean(quality) && isRecognitionLevel(quality?.level) && typeof quality?.score === 'number';

  if (!native && !hasQuality) return null;

  const level = hasQuality ? quality!.level : undefined;
  const pages = hasQuality ? quality!.pages : undefined;
  const showPages = Boolean(!compact && pages && pages.length > 0);

  const line = native
    ? '电子文本'
    : `识别质量 ${LEVEL_LABEL[level!]} · ${percent(quality!.score)}`;

  return (
    <div
      className={`ui-recognition-quality${compact ? ' ui-recognition-quality--compact' : ''}${level === 'low' ? ' ui-recognition-quality--low' : ''}`}
      data-testid="recognition-quality"
    >
      {compact && fileName ? <span className="ui-recognition-quality-file">{fileName}</span> : null}
      <span className="ui-recognition-quality-line">{line}</span>
      {level === 'low' ? (
        <span className="ui-recognition-quality-warn">部分文字可能不准确，请对照原文。</span>
      ) : null}
      {showPages ? (
        <div className="ui-recognition-quality-pages">
          <button
            type="button"
            className="ui-btn ui-btn--sm ui-btn--ghost"
            onClick={() => setPagesOpen((v) => !v)}
          >
            按页
          </button>
          {pagesOpen ? (
            <ul className="ui-recognition-quality-page-list">
              {pages!.map((p) => (
                <li key={p.page}>{`第 ${p.page} 页 · ${percent(p.score)}`}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
