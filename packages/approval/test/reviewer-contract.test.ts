import { describe, expect, it } from 'vitest';
import { parseReviewerDecision } from '../src/security/index.js';

describe('parseReviewerDecision', () => {
  it('accepts only the fixed decision/risk pairs', () => {
    expect(parseReviewerDecision(
      '{"decision":"allow","risk":"low","reason":"普通测试命令"}',
    )).toEqual({ decision: 'allow', risk: 'low', reason: '普通测试命令' });
    expect(parseReviewerDecision(
      '{"decision":"allow","risk":"medium","reason":"本地构建"}',
    )).toEqual({ decision: 'allow', risk: 'medium', reason: '本地构建' });
    expect(parseReviewerDecision(
      '{"decision":"ask","risk":"high","reason":"上下文不足"}',
    )).toEqual({ decision: 'ask', risk: 'high', reason: '上下文不足' });
    expect(parseReviewerDecision(
      '{"decision":"deny","risk":"critical","reason":"灾难目标"}',
    )).toEqual({ decision: 'deny', risk: 'critical', reason: '灾难目标' });
    expect(() => parseReviewerDecision(
      '{"decision":"allow","risk":"critical","reason":"x"}',
    )).toThrow();
  });

  it('rejects extra fields, free text and non-JSON payloads', () => {
    expect(() => parseReviewerDecision(
      '{"decision":"allow","risk":"low","reason":"x","extra":true}',
    )).toThrow();
    expect(() => parseReviewerDecision('sure, go ahead')).toThrow(/not JSON/);
    expect(() => parseReviewerDecision('null')).toThrow();
    expect(() => parseReviewerDecision('[]')).toThrow();
    expect(() => parseReviewerDecision(
      '{"decision":"allow","risk":"low","reason":"   "}',
    )).toThrow(/reason/);
    expect(() => parseReviewerDecision(
      '{"decision":"allow","reason":"x"}',
    )).toThrow();
    expect(() => parseReviewerDecision(
      '{"decision":"yolo","risk":"low","reason":"x"}',
    )).toThrow();
  });

  it('trims and bounds the reason so it cannot smuggle a transcript', () => {
    const long = 'x'.repeat(5_000);
    const parsed = parseReviewerDecision(
      `{"decision":"deny","risk":"critical","reason":"  ${long}  "}`,
    );
    expect(parsed.reason).toHaveLength(500);
    expect(parsed.reason).toBe('x'.repeat(500));
  });
});
