export type DocumentEngine = 'native' | 'structure';
export type RecognitionLevel = 'high' | 'mid' | 'low';
export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'text' | 'image';

export interface RecognitionQuality {
  score: number;
  level: RecognitionLevel;
  pages: Array<{ page: number; score: number; level: RecognitionLevel }>;
}

export interface ParsedDocument {
  text: string;
  kind: DocumentKind;
  engine: DocumentEngine;
  meta: {
    fileName: string;
    pageCount?: number;
    quality?: RecognitionQuality;
    skippedModules?: string[];
    ignoredCount?: number;
  };
}
