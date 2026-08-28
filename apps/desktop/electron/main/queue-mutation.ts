export type QueueName = 'steering' | 'followUp';

export interface QueueSnapshot {
  steering: string[];
  followUp: string[];
}

export type QueueMutation =
  | { action: 'edit'; queue: QueueName; index: number; text: string }
  | { action: 'delete'; queue: QueueName; index: number }
  | { action: 'move'; queue: QueueName; fromIndex: number; toIndex: number }
  | { action: 'transfer'; queue: QueueName; index: number; targetQueue: QueueName };

function cloneSnapshot(snapshot: QueueSnapshot): QueueSnapshot {
  return {
    steering: [...snapshot.steering],
    followUp: [...snapshot.followUp],
  };
}

function assertIndex(items: string[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new Error(`invalid queue index ${index}`);
  }
}

export function mutateQueues(snapshot: QueueSnapshot, mutation: QueueMutation): QueueSnapshot {
  const next = cloneSnapshot(snapshot);

  if (mutation.action === 'edit') {
    assertIndex(next[mutation.queue], mutation.index);
    next[mutation.queue][mutation.index] = mutation.text;
    return next;
  }

  if (mutation.action === 'delete') {
    assertIndex(next[mutation.queue], mutation.index);
    next[mutation.queue].splice(mutation.index, 1);
    return next;
  }

  if (mutation.action === 'move') {
    assertIndex(next[mutation.queue], mutation.fromIndex);
    if (!Number.isInteger(mutation.toIndex) || mutation.toIndex < 0 || mutation.toIndex > next[mutation.queue].length) {
      throw new Error(`invalid queue target index ${mutation.toIndex}`);
    }
    const [item] = next[mutation.queue].splice(mutation.fromIndex, 1);
    next[mutation.queue].splice(mutation.toIndex, 0, item);
    return next;
  }

  if (mutation.action === 'transfer') {
    if (mutation.queue === mutation.targetQueue) {
      assertIndex(next[mutation.queue], mutation.index);
      const [item] = next[mutation.queue].splice(mutation.index, 1);
      next[mutation.queue].push(item);
      return next;
    }
    assertIndex(next[mutation.queue], mutation.index);
    const [item] = next[mutation.queue].splice(mutation.index, 1);
    next[mutation.targetQueue].push(item);
    return next;
  }

  return next;
}
