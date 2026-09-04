import { describe, expect, it } from 'vitest';
import { contractSessionTitle } from '../agents/contract-review/surface/title.js';

describe('contractSessionTitle', () => {
  it('strips the last extension and keeps names under 20 characters', () => {
    expect(contractSessionTitle('采购合同.pdf')).toBe('采购合同');
    expect(contractSessionTitle('合同.最终版.docx')).toBe('合同.最终版');
    expect(contractSessionTitle('只有名字')).toBe('只有名字');
    expect(contractSessionTitle('非常非常长的合同文件名一共二十多个字还要再长.docx')).toBe('非常非常长的合同文件名一共二十多个字还要');
    expect(contractSessionTitle('非常非常长的合同文件名一共二十多个字还要再长.docx')).not.toMatch(/docx/);
    expect(contractSessionTitle('.pdf')).toBe('合同审核');
  });
});
