import { describe, it, expect } from 'vitest';
import { present, partitionApprovals, PREVIEW_VISIBLE_LINES } from '../src/trust/present.js';

describe('present', () => {
  it('uses summary as-is and falls back when blank', () => {
    expect(present({ summary: '写入 hello.txt', risk: 'write' }).title).toBe('写入 hello.txt');
    expect(present({ summary: '  ', risk: 'write' }).title).toBe('需要你确认');
    expect(present({ summary: '', risk: 'write' }).title).toBe('需要你确认');
  });

  it('does not infer preview from payload.diff', () => {
    const proposal = { summary: '写入 a.txt', risk: 'write', payload: { diff: '--- a/a.txt\n+++ b/a.txt\n+hi' } };
    expect(present(proposal).preview.kind).toBe('none');
    expect(present(proposal).preview.lines).toEqual([]);
  });

  it('truncates preview to five visible lines', () => {
    const lines = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const vm = present({ summary: '写入 a.txt', risk: 'write', preview: { kind: 'diff', lines } });
    expect(PREVIEW_VISIBLE_LINES).toBe(5);
    expect(vm.preview.kind).toBe('diff');
    expect(vm.preview.lines).toEqual(lines);
    expect(vm.preview.visibleLines).toEqual(['1', '2', '3', '4', '5']);
    expect(vm.preview.hiddenCount).toBe(3);
  });

  it('sends high-risk to a modal with risk, countdown and note', () => {
    const vm = present({ summary: '永久删除 reports/', risk: 'high-risk', preview: { kind: 'text', lines: ['$ rm -rf reports'] } });
    expect(vm.chrome).toEqual({ mode: 'modal', showRisk: true, showCountdown: true, showNote: true });
    expect(vm.subtitle).toBe('可能无法恢复');
    expect(vm.preview.kind).toBe('text');
  });

  it('treats write as a routine panel without a visible countdown', () => {
    const vm = present({ summary: '写入 hello.txt', risk: 'write' });
    expect(vm.chrome).toEqual({ mode: 'panel', showRisk: false, showCountdown: false, showNote: false });
    expect(vm.subtitle).toBeNull();
  });

  it('uses reject / allow / confirm-allow labels', () => {
    const vm = present({ summary: 'x', risk: 'write' });
    expect(vm.actions).toEqual({ reject: '拒绝', allow: '允许', confirmAllow: '再次确认允许' });
  });

  it('partitions pending proposals by chrome mode', () => {
    const write = { id: 'w', summary: '写入', risk: 'write' };
    const high = { id: 'h', summary: '删除', risk: 'high-risk' };
    expect(partitionApprovals([write, high])).toEqual({ routine: [write], highRisk: [high] });
    expect(partitionApprovals([{ id: 'r', summary: '读', risk: 'read' }]).routine).toHaveLength(1);
  });
});
