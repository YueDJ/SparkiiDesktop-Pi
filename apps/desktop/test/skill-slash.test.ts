import { describe, expect, it } from 'vitest';
import { parseLeadingSkillSlash } from '@sparkii/ui';

describe('parseLeadingSkillSlash', () => {
  it('parses a bare destName slash', () => {
    expect(parseLeadingSkillSlash('/brainstorming')).toEqual({ name: 'brainstorming', rest: '' });
    expect(parseLeadingSkillSlash('/superpowers')).toEqual({ name: 'superpowers', rest: '' });
  });

  it('keeps rest after a single whitespace character', () => {
    expect(parseLeadingSkillSlash('/brainstorming 帮我拆')).toEqual({ name: 'brainstorming', rest: '帮我拆' });
    expect(parseLeadingSkillSlash('/brainstorming\n\n第二段')).toEqual({ name: 'brainstorming', rest: '\n第二段' });
    expect(parseLeadingSkillSlash('/brainstorming   x')).toEqual({ name: 'brainstorming', rest: '  x' });
  });

  it('trims only leading whitespace before the slash', () => {
    expect(parseLeadingSkillSlash('  /brainstorming')).toEqual({ name: 'brainstorming', rest: '' });
  });

  it('rejects non destName-shaped tokens', () => {
    expect(parseLeadingSkillSlash('/skill:brainstorming')).toBeNull();
    expect(parseLeadingSkillSlash('请看 /brainstorming')).toBeNull();
    expect(parseLeadingSkillSlash('/BRAINSTORMING')).toBeNull();
    expect(parseLeadingSkillSlash('/MySkill')).toBeNull();
    expect(parseLeadingSkillSlash(`/${'a'.repeat(65)}`)).toBeNull();
    expect(parseLeadingSkillSlash('/contract_risk_review')).toBeNull();
    expect(parseLeadingSkillSlash('hello')).toBeNull();
  });
});
