import { useEffect, useState } from 'react';
import { SelectMenu } from '@sparkii/ui';
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
  const options = [
    { value: ALL, label: '全部可见库' },
    ...datasets.map((d) => ({ value: d.id, label: d.name })),
  ];

  return (
    <SelectMenu
      data-testid="knowledge-dataset-select"
      aria-label="知识库"
      value={selected}
      placeholder="选择知识库"
      options={options}
      placement="top"
      onChange={(next) => {
        onChange(next === ALL ? { mode: 'all' } : { mode: 'ids', datasetIds: [next] });
      }}
    />
  );
}
