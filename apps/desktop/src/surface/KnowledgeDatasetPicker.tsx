import { useEffect, useState } from 'react';
import { Select } from '@sparkii/ui';
import type { SparkiiApi } from '../types/sparkii-api.js';
import type { KnowledgeSelection } from '../../electron/preload/api-types.js';

const ALL = '__all__';

export function KnowledgeDatasetPicker(props: {
  api: SparkiiApi;
  value: KnowledgeSelection;
  onChange(next: KnowledgeSelection): void;
}) {
  const { api, value, onChange } = props;
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    void api.listRagDatasets?.().then((result) => {
      if (result?.ok) setDatasets(result.datasets ?? []);
    }).catch(() => setDatasets([]));
  }, [api]);

  const selected = value.mode === 'all' ? ALL : (value.datasetIds[0] ?? '');

  return (
    <Select
      data-testid="knowledge-dataset-select"
      value={selected}
      onChange={(e) => {
        const next = e.target.value;
        onChange(next === ALL ? { mode: 'all' } : { mode: 'ids', datasetIds: [next] });
      }}
    >
      {selected === '' ? <option value="" disabled>选择知识库</option> : null}
      <option value={ALL}>全部可见库</option>
      {datasets.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </Select>
  );
}
