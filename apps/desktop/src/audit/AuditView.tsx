import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';

export function AuditView(props: { api: SparkiiApi }) {
  const [rows, setRows] = useState<unknown[]>([]);
  useEffect(() => { props.api.queryAudit({}).then(setRows); }, [props.api]);
  return <table>{rows.map((r: any, i) => <tr key={i}><td>{r.ts}</td><td>{r.actor}</td><td>{r.action}</td><td>{r.resource}</td></tr>)}</table>;
}
