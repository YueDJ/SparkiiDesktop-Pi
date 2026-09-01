import type { Connector, ToolHandler } from '../types.js';

export interface KnowledgeChunk { id: string; text: string; score: number }

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export class Bm25Index {
  private tf: Map<string, Map<string, number>> = new Map();
  private len = new Map<string, number>();
  private df = new Map<string, number>();
  private avg = 0;
  private docs: Array<{ id: string; text: string }> = [];

  constructor(corpus: Array<{ id: string; text: string }>, private k1 = 1.2, private b = 0.75) {
    this.docs = corpus;
    for (const doc of corpus) {
      const toks = tokenize(doc.text);
      this.len.set(doc.id, toks.length);
      const seen = new Set<string>();
      const counts = new Map<string, number>();
      for (const t of toks) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
        seen.add(t);
      }
      this.tf.set(doc.id, counts);
      for (const t of seen) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = corpus.length ? corpus.reduce((s, d) => s + (this.len.get(d.id) ?? 0), 0) / corpus.length : 0;
  }

  search(query: string, topK: number): KnowledgeChunk[] {
    const q = tokenize(query);
    const n = this.docs.length;
    return this.docs.map((doc) => {
      const toks = tokenize(doc.text);
      const score = q.reduce((sum, t) => {
        const f = this.tf.get(doc.id)?.get(t) ?? 0;
        if (f === 0) return sum;
        const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        const dl = this.len.get(doc.id) ?? 0;
        return sum + idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (dl / (this.avg || 1)))));
      }, 0);
      return { id: doc.id, text: toks.join(' '), score };
    }).sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

export function buildIndexFromLines(lines: string[]): Bm25Index {
  return new Bm25Index(lines.map((text, i) => ({ id: `chunk-${i}`, text })));
}

const indexes = new Map<string, Bm25Index>();

const handler: ToolHandler = async (args, ctx) => {
  const index = indexes.get(ctx.profileId) ?? indexes.get('default');
  if (!index) return { ok: false, error: { code: 'CONNECTOR_NOT_INIT', message: 'knowledge corpus not loaded' } };
  return { ok: true, data: index.search(String(args.query), Number(args.topK ?? 5)) };
};

export const knowledgeConnector: Connector = {
  id: 'knowledge',
  tools: [{
    name: 'knowledge.search',
    description: '在法规知识库中检索与查询最相关的条款片段。',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number' },
      },
      required: ['query'],
    },
    sideEffect: 'read',
    handler,
  }],
  async init(cfg: unknown) {
    const parsed = cfg as { corpus?: Array<{ id: string; text: string }>; profileId?: string } | undefined;
    const corpus = parsed?.corpus ?? [];
    indexes.set(parsed?.profileId ?? 'default', new Bm25Index(corpus));
  },
};
