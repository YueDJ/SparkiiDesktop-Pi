import { useEffect, useState } from 'react';
import type { AgentSurfaceProps, SessionEntry } from '../../../src/surface/contract.js';
import { PackPage } from './pack.js';
import { Workbench, type UiPage } from './workbench.js';
import './styles.css';

function hasReviewOutput(entries: SessionEntry[]): boolean {
  return entries.some((e) => (
    e.kind === 'custom'
    && e.customType === 'workflow_step_end'
    && String(e.data.stepId ?? '') === 'review'
  ));
}

export default function ProcurementSurface(props: AgentSurfaceProps) {
  const reviewReady = hasReviewOutput(props.session.entries);
  const [page, setPage] = useState<UiPage>(reviewReady ? 'run' : 'pack');

  useEffect(() => {
    setPage((current) => {
      const ready = hasReviewOutput(props.session.entries);
      if (!ready) return 'pack';
      if (current === 'pack') return 'run';
      return current;
    });
  }, [props.sessionId, reviewReady]);

  if (!reviewReady || page === 'pack') {
    return <PackPage {...props} />;
  }

  return <Workbench {...props} page={page} onPageChange={setPage} />;
}
