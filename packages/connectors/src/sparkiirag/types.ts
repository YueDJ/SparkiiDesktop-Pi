export type SparkiiRagRetrieveInput = {
  question: string;
  datasetIds: string[];
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  topK?: number;
};

export type RetrievalChunk = {
  id: string;
  content: string;
  documentId: string;
  documentName: string;
  datasetId: string;
  similarity: number;
  termSimilarity?: number;
  vectorSimilarity?: number;
  positions?: unknown;
};

export type RetrievalResult = {
  chunks: RetrievalChunk[];
  documents: Array<{ documentId: string; documentName: string; chunkCount: number }>;
};

export type SparkiiRagDataset = { id: string; name: string };
