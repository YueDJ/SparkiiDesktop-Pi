import { describe, it, expect } from 'vitest';
import { mutateQueues } from '../electron/main/queue-mutation.js';

describe('mutateQueues', () => {
  const snapshot = {
    steering: ['先做这个'],
    followUp: ['做完后整理', '再跑一遍测试'],
  };

  it('edits one item in place', () => {
    expect(mutateQueues(snapshot, { action: 'edit', queue: 'followUp', index: 1, text: '再跑一遍验收' }))
      .toEqual({
        steering: ['先做这个'],
        followUp: ['做完后整理', '再跑一遍验收'],
      });
  });

  it('deletes one item', () => {
    expect(mutateQueues(snapshot, { action: 'delete', queue: 'followUp', index: 0 }))
      .toEqual({
        steering: ['先做这个'],
        followUp: ['再跑一遍测试'],
      });
  });

  it('moves an item within the same queue', () => {
    expect(mutateQueues(snapshot, { action: 'move', queue: 'followUp', fromIndex: 0, toIndex: 1 }))
      .toEqual({
        steering: ['先做这个'],
        followUp: ['再跑一遍测试', '做完后整理'],
      });
  });

  it('transfers an item to the target queue', () => {
    expect(mutateQueues(snapshot, { action: 'transfer', queue: 'followUp', index: 0, targetQueue: 'steering' }))
      .toEqual({
        steering: ['先做这个', '做完后整理'],
        followUp: ['再跑一遍测试'],
      });
  });

  it('throws for an invalid index', () => {
    expect(() => mutateQueues(snapshot, { action: 'delete', queue: 'steering', index: 9 }))
      .toThrow();
  });
});
