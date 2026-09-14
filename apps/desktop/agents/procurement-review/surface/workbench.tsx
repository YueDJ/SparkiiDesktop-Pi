import { useMemo } from 'react';
import type { AgentSurfaceProps, CustomSessionEntry, SessionEntry } from '../../../src/surface/contract.js';
import { extractWorkflowResult } from '../../../src/surface/normalize.js';
import type { EvaluationSnapshot, JoinedLine } from '../engine/types.js';
import { sanitizeFindings, type Finding } from './findings.js';

export type UiPage = 'pack' | 'run' | 'review';
export type ReviewState = 'none' | 'confirmed' | 'ignored' | 'escalated';

const EMPTY_SNAP: EvaluationSnapshot = {
  lines: [],
  hits: [],
  closed: { qty: true, price: true, time: true, compliance: true },
  conflicts: [],
};

function reviewStateEntries(entries: SessionEntry[]): CustomSessionEntry[] {
  return entries.filter((e): e is CustomSessionEntry => e.kind === 'custom' && e.customType === 'workflow_state');
}

function stateAction(e: CustomSessionEntry): string {
  return String(e.data.action ?? '');
}

function statePayload(e: CustomSessionEntry): Record<string, unknown> {
  const payload = e.data.payload;
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

function evaluationFromEntries(entries: SessionEntry[]): EvaluationSnapshot {
  let snap: EvaluationSnapshot | null = null;
  for (const e of reviewStateEntries(entries)) {
    if (stateAction(e) !== 'evaluation') continue;
    const payload = statePayload(e);
    if (!Array.isArray(payload.hits) || !payload.closed || typeof payload.closed !== 'object') continue;
    snap = payload as unknown as EvaluationSnapshot;
  }
  return snap ?? EMPTY_SNAP;
}

function initialReviewState(entries: SessionEntry[]): Record<string, ReviewState> {
  const next: Record<string, ReviewState> = {};
  for (const e of reviewStateEntries(entries)) {
    const payload = statePayload(e);
    const riskId = typeof payload.riskId === 'string' ? payload.riskId : '';
    if (!riskId) continue;
    const action = stateAction(e);
    if (action === 'risk_confirmed') next[riskId] = 'confirmed';
    if (action === 'risk_ignored') next[riskId] = 'ignored';
    if (action === 'risk_escalated') next[riskId] = 'escalated';
    if (action === 'risk_none') next[riskId] = 'none';
  }
  return next;
}

export function highRiskBlocking(
  findings: Array<{ id: string; level: string }>,
  states: Record<string, ReviewState | undefined>,
): boolean {
  return findings.some((f) => f.level === 'high' && (states[f.id] ?? 'none') === 'none');
}

function dash(open: boolean, value: number | string | null | undefined): string {
  if (!open || value == null || value === '') return '—';
  return String(value);
}

function dimLabel(dim: Finding['dim']): string {
  if (dim === 'qty') return '量';
  if (dim === 'price') return '价';
  if (dim === 'time') return '时';
  if (dim === 'completeness') return '整';
  return '规';
}

function FindingCard({
  finding,
  withOps,
  state,
  onReview,
}: {
  finding: Finding;
  withOps: boolean;
  state: ReviewState;
  onReview: (id: string, action: Exclude<ReviewState, 'none'>) => void;
}) {
  return (
    <article className="find">
      <div className="find-top">
        <span className={`badge ${finding.level}`}>{finding.level === 'high' ? '高' : '中'}</span>
        <b>{finding.title}</b>
      </div>
      {finding.reason ? <p>{finding.reason}</p> : null}
      {finding.advice ? <p>{finding.advice}</p> : null}
      <div className="cite">依据 {finding.cite.label}</div>
      {withOps ? (
        <div className="ops">
          <button type="button" className={state === 'confirmed' ? 'on-ok' : ''} onClick={() => onReview(finding.id, 'confirmed')}>采纳</button>
          <button type="button" className={state === 'ignored' ? 'on-ignore' : ''} onClick={() => onReview(finding.id, 'ignored')}>忽略</button>
          <button type="button" className={state === 'escalated' ? 'on-up' : ''} onClick={() => onReview(finding.id, 'escalated')}>升级</button>
        </div>
      ) : null}
    </article>
  );
}

function DimPane({
  mark,
  title,
  items,
  closed,
  withOps,
  states,
  onReview,
}: {
  mark: string;
  title: string;
  items: Finding[];
  closed: boolean;
  withOps: boolean;
  states: Record<string, ReviewState>;
  onReview: (id: string, action: Exclude<ReviewState, 'none'>) => void;
}) {
  const high = items.filter((f) => f.level === 'high').length;
  const done = items.filter((f) => (states[f.id] ?? 'none') !== 'none').length;
  const tone = closed ? '' : high ? 'has-high' : items.length ? 'has-mid' : 'ready';
  const status = closed
    ? '未评估'
    : !items.length
      ? '无异常'
      : withOps
        ? `${done}/${items.length} 已处理`
        : (high ? `${high} 条高风险` : `${items.length} 条`);
  return (
    <div className={`cond ${tone}`}>
      <div className="cond-top">
        <span className="mark">{mark}</span>
        <span className={`status ${closed || (high && done < items.length) ? 'wait' : 'on'}`}>{status}</span>
      </div>
      <h3>{title}</h3>
      {closed ? (
        <p className="none">对照未提交。</p>
      ) : items.length ? (
        items.map((f) => (
          <FindingCard key={f.id} finding={f} withOps={withOps} state={states[f.id] ?? 'none'} onReview={onReview} />
        ))
      ) : (
        <p className="none">未命中规则。</p>
      )}
    </div>
  );
}

function PlanTable({ lines, snap }: { lines: JoinedLine[]; snap: EvaluationSnapshot }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>编码</th><th>物资</th><th>本次</th><th>库存</th><th>领用</th><th>单价</th><th>中位价</th><th>在途</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>{line.code ?? '—'}</td>
            <td>{line.name}</td>
            <td>{dash(true, line.qty)}</td>
            <td>{dash(line.qtyOpen, line.stockQty)}</td>
            <td>{dash(line.qtyOpen, line.usageQty)}</td>
            <td>{dash(true, line.unitPrice)}</td>
            <td>{dash(line.priceOpen, line.medianPrice)}</td>
            <td>{dash(line.timeOpen, line.transitQty)}</td>
          </tr>
        ))}
        {lines.length === 0 && snap.banner ? (
          <tr><td colSpan={8}>{snap.banner}</td></tr>
        ) : null}
      </tbody>
    </table>
  );
}

export function Workbench({
  session,
  actions,
  page,
  onBackToPack,
  onBackToAnalyze,
  onEnterReview,
}: AgentSurfaceProps & {
  page: 'run' | 'review';
  onBackToPack: () => void;
  onBackToAnalyze: () => void;
  onEnterReview: () => void;
}) {
  const snap = useMemo(() => evaluationFromEntries(session.entries), [session.entries]);
  const findings = useMemo(
    () => sanitizeFindings(extractWorkflowResult(session.entries).review, snap),
    [session.entries, snap],
  );
  const states = useMemo(() => initialReviewState(session.entries), [session.entries]);
  const review = page === 'review';

  const qty = findings.filter((f) => f.dim === 'qty');
  const price = findings.filter((f) => f.dim === 'price');
  const time = findings.filter((f) => f.dim === 'time');
  const rule = findings.filter((f) => f.dim === 'compliance' || f.dim === 'completeness');
  const thin = snap.closed.qty && snap.closed.price && snap.closed.time;
  const blocking = highRiskBlocking(findings, states);
  const handled = findings.filter((f) => (states[f.id] ?? 'none') !== 'none').length;
  const highLeft = findings.filter((f) => f.level === 'high' && (states[f.id] ?? 'none') === 'none').length;
  const skipRules = thin;
  const skipPolicy = snap.closed.compliance;

  const applyReview = (id: string, action: Exclude<ReviewState, 'none'>) => {
    actions.review(`risk_${action}`, { stepId: 'review', payload: { riskId: id } });
  };

  const stepNo = review ? 3 : 2;

  return (
    <div className="procurement">
      <div className="page">
        <h1>财务采购审核</h1>
        <p className="lead">审核需求计划的数量、单价、时点与程序合规。</p>
        <nav className="stepper" aria-label="审核步骤">
          <button className={`step ${stepNo > 1 ? 'done' : 'on'}`} type="button" onClick={onBackToPack}>
            <span className="n">1</span>
            <span><b>准备</b><em>计划与对照</em></span>
          </button>
          <span className={`step-line ${stepNo > 1 ? 'done' : ''}`} />
          <button className={`step ${stepNo === 2 ? 'on' : stepNo > 2 ? 'done' : ''}`} type="button" onClick={onBackToAnalyze}>
            <span className="n">2</span>
            <span><b>分析</b><em>生成结论</em></span>
          </button>
          <span className={`step-line ${stepNo > 2 ? 'done' : ''}`} />
          <button className={`step ${stepNo === 3 ? 'on' : ''}`} type="button" onClick={onEnterReview}>
            <span className="n">3</span>
            <span><b>复核</b><em>确认意见</em></span>
          </button>
        </nav>

        <div className="shell">
          <div className="toolbar">
            <div>
              <div className="title">财务采购审核</div>
              <div className="sub">{snap.lines.length ? `${snap.lines.length} 行` : ''}</div>
            </div>
            <div className="toolbar-right">
              <span className={`chip ${snap.closed.qty ? 'off' : 'on'}`}>量</span>
              <span className={`chip ${snap.closed.price ? 'off' : 'on'}`}>价</span>
              <span className={`chip ${snap.closed.time ? 'off' : 'on'}`}>时</span>
              <span className={`chip ${snap.closed.compliance ? 'off' : 'on'}`}>合规</span>
            </div>
          </div>

          {review ? (
            <div className="progress">
              <span className={`prog ${highLeft ? '' : 'done'}`}><i />{highLeft ? `${highLeft} 条高风险待处理` : '高风险已处理'}</span>
              <span className="prog done"><i />已处理 {handled}/{findings.length}</span>
            </div>
          ) : (
            <div className="progress" aria-label="分析进度">
              <span className="prog done"><i />对齐编码</span>
              <span className="prog done"><i />完整性</span>
              <span className={`prog ${skipRules ? 'skip' : 'done'}`}><i />套规则{skipRules ? ' · 跳过' : ''}</span>
              <span className={`prog ${skipPolicy ? 'skip' : 'done'}`}><i />制度{skipPolicy ? ' · 跳过' : ''}</span>
              <span className="prog done"><i />撰写发现</span>
            </div>
          )}

          <div className="analyze">
            {thin ? <div className="banner">对照数据未提交，数量、单价、时点未评估。</div> : null}
            {snap.banner && !thin ? <div className="banner">{snap.banner}</div> : null}
            <div className="sheet">
              <PlanTable lines={snap.lines} snap={snap} />
            </div>
            <div className="conds">
              <DimPane mark="量" title="数量" items={qty} closed={snap.closed.qty} withOps={review} states={states} onReview={applyReview} />
              <DimPane mark="价" title="单价" items={price} closed={snap.closed.price} withOps={review} states={states} onReview={applyReview} />
              <DimPane mark="时" title="时点" items={time} closed={snap.closed.time} withOps={review} states={states} onReview={applyReview} />
              {rule.length ? (
                <div className={`cond rule-bar ${rule.some((f) => f.level === 'high') ? 'has-high' : 'has-mid'}`}>
                  <div className="cond-top">
                    <span className="mark">{thin ? '整' : dimLabel('compliance')}</span>
                    <span className="status wait">{thin ? '完整性 / 合规' : '合规'}</span>
                  </div>
                  <h3>{thin ? '完整性' : '程序合规'}</h3>
                  {rule.map((f) => (
                    <FindingCard key={f.id} finding={f} withOps={review} state={states[f.id] ?? 'none'} onReview={applyReview} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {review ? (
            <div className="gate">
              <div>
                <b>{blocking ? '高风险待处理' : '可以写入意见'}</b>
                <p className={`miss ${blocking ? 'warn' : ''}`}>
                  {blocking ? '高风险须采纳、忽略或升级后，才能导出。' : '写入后走审批，再导出。'}
                </p>
              </div>
              <div className="gate-actions">
                <button className="btn" type="button" onClick={onBackToAnalyze}>返回分析</button>
                <button className="btn" type="button" disabled={blocking}>写入意见</button>
                <button className="btn primary" type="button" disabled={blocking}>导出</button>
              </div>
            </div>
          ) : (
            <div className="gate">
              <div>
                <b>分析完成</b>
                <p className="miss">
                  {snap.lines.length} 行已对齐 · {findings.length} 条发现
                  {snap.closed.compliance ? ' · 制度未选用' : ''}
                </p>
              </div>
              <div className="gate-actions">
                <button className="btn" type="button" onClick={onBackToPack}>返回准备</button>
                <button className="btn primary" type="button" onClick={onEnterReview}>进入复核</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
