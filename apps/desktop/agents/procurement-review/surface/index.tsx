import { useEffect, useRef, useState } from 'react';
import type { AgentSurfaceProps, SessionEntry } from '../../../src/surface/contract.js';
import { EMPTY_PACK_FILES, PackPage, type PackFiles, type PackSlot } from './pack.js';
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
  const [files, setFiles] = useState<PackFiles>(EMPTY_PACK_FILES);
  const sessionIdRef = useRef(props.sessionId);
  const readyRef = useRef(reviewReady);

  const goPack = () => setPage('pack');
  const goRun = () => setPage('run');
  const goReview = () => setPage('review');

  const onFile = (slot: PackSlot, file: File) => {
    setFiles((prev) => ({ ...prev, [slot]: file }));
  };

  useEffect(() => {
    const sessionChanged = sessionIdRef.current !== props.sessionId;
    const becameReady = !readyRef.current && reviewReady;
    sessionIdRef.current = props.sessionId;
    readyRef.current = reviewReady;
    setPage((current) => {
      if (!reviewReady) return 'pack';
      if (sessionChanged || becameReady) return 'run';
      return current;
    });
  }, [props.sessionId, reviewReady]);

  const packPage = <PackPage {...props} files={files} onFile={onFile} />;

  if (!reviewReady) {
    return packPage;
  }

  if (page === 'pack') {
    return (
      <div className="procurement-stack">
        {packPage}
        <div className="procurement">
          <div className="gate pack-resume">
            <div>
              <b>分析已完成</b>
              <p className="miss">可返回分析或进入复核。</p>
            </div>
            <div className="gate-actions">
              <button className="btn" type="button" onClick={goRun}>返回分析</button>
              <button className="btn primary" type="button" onClick={goReview}>进入复核</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Workbench
      {...props}
      page={page}
      onBackToPack={goPack}
      onBackToAnalyze={goRun}
      onEnterReview={goReview}
    />
  );
}
