import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';

export function ChatWorkbench(props: { api: SparkiiApi }) {
  const [items, setItems] = useState<Array<{ role: string; text?: string; tool?: string }>>([]);
  const [draft, setDraft] = useState('');
  useEffect(() => props.api.on('chat-event', (p) => setItems((xs) => [...xs, p as any])), [props.api]);
  return (
    <div>
      <div>{items.map((m, i) => <div key={i}>{m.role}: {m.text ?? m.tool}</div>)}</div>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => { props.api.prompt(draft); setDraft(''); }}>发送</button>
    </div>
  );
}
