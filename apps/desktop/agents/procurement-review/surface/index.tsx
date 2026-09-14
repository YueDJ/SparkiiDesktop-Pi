import { useEffect, useRef, useState } from 'react';
import type { AgentSurfaceProps } from '../../../src/surface/contract.js';
import { DEFAULT_PACK_PREFS, EMPTY_PACK_FILES, PackPage, type PackFiles, type PackPrefs, type PackSlot } from './pack.js';
import { hasReviewOutput } from './progress.js';
import { Workbench, type UiPage } from './workbench.js';
import './styles.css';

export default function ProcurementSurface(props: AgentSurfaceProps) {
  const live = props.session.streaming || props.session.status === 'running';
  const reviewReady = hasReviewOutput(props.session.entries);
  const [page, setPage] = useState<UiPage>(reviewReady || live ? 'run' : 'pack');
  const [files, setFiles] = useState<PackFiles>(EMPTY_PACK_FILES);
  const [prefs, setPrefs] = useState<PackPrefs>(DEFAULT_PACK_PREFS);
  const sessionIdRef = useRef(props.sessionId);
  const readyRef = useRef(reviewReady);

  const goPack = () => setPage('pack');
  const goRun = () => setPage('run');
  const goReview = () => { if (reviewReady) setPage('review'); };

  const onFile = (slot: PackSlot, file: File) => {
    setFiles((prev) => ({ ...prev, [slot]: file }));
  };

  useEffect(() => {
    const sessionChanged = sessionIdRef.current !== props.sessionId;
    const becameReady = !readyRef.current && reviewReady;
    if (sessionChanged) {
      setFiles(EMPTY_PACK_FILES);
      setPrefs(DEFAULT_PACK_PREFS);
    }
    sessionIdRef.current = props.sessionId;
    readyRef.current = reviewReady;
    setPage((current) => {
      if (!reviewReady && !live) return 'pack';
      if (sessionChanged || becameReady) return 'run';
      return current;
    });
  }, [props.sessionId, reviewReady]);

  const packPage = (
    <PackPage
      key={props.sessionId ?? 'new'}
      {...props}
      files={files}
      onFile={onFile}
      prefs={prefs}
      onPrefs={setPrefs}
    />
  );

  if (!reviewReady && !live) {
    return packPage;
  }

  if (page === 'pack') {
    return (
      <div className="procurement-stack">
        {packPage}
        <div className="procurement">
          <div className="gate pack-resume">
            <div>
              <b>{reviewReady ? '分析已完成' : '分析进行中'}</b>
              <p className="miss">{reviewReady ? '可返回分析或进入复核。' : '稍后可返回分析查看进度。'}</p>
            </div>
            <div className="gate-actions">
              <button className="btn" type="button" onClick={goRun}>返回分析</button>
              <button className="btn primary" type="button" disabled={!reviewReady} onClick={goReview}>进入复核</button>
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
