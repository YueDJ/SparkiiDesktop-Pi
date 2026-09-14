import { describe, it, expect } from 'vitest';
import { poolMeta, profilePoolMeta } from '../electron/main/pool-meta.js';

describe('poolMeta', () => {
  it('uses displayName and defaults the label to 新会话', () => {
    expect(poolMeta('contract-review', '合同审核智能体')).toEqual({
      profileId: 'contract-review',
      profileName: '合同审核智能体',
      label: '新会话',
    });
  });

  it('keeps a provided session title and falls back to profileId without displayName', () => {
    expect(poolMeta('contract-review', '  ', '  采购合同  ')).toEqual({
      profileId: 'contract-review',
      profileName: 'contract-review',
      label: '采购合同',
    });
  });

  it('reads displayName from the profile runtime', () => {
    const rt = {
      profileOf: (id: string) => ({
        profile: { manifest: { displayName: id === 'contract-review' ? '合同审核智能体' : undefined } },
      }),
    };
    expect(profilePoolMeta(rt, 'contract-review', '采购合同')).toEqual({
      profileId: 'contract-review',
      profileName: '合同审核智能体',
      label: '采购合同',
    });
  });
});
