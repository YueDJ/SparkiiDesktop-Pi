import { useRef, useState, type ChangeEvent } from 'react';
import { SelectMenu } from '@sparkii/ui';
import type { AgentSurfaceActions, AgentSurfaceProps } from '../../../src/surface/contract.js';
import { DEFAULT_RULES } from '../engine/default-rules.js';
import { prepareWorkflowInput } from '../engine/evaluate.js';
import { extractPlanNo, parseCsv, parseFactTable, parsePlanTable, parseXlsxBuffer } from '../engine/parse.js';
import type { FactTables, PackInput, PolicyKb } from '../engine/types.js';
import { procurementSessionTitle } from './title.js';

export interface PackUiState {
  planReady: boolean;
  qtyReady: boolean;
  priceReady: boolean;
  timeReady: boolean;
  policyKb: 'default' | null;
}

export type PackSlot = 'plan' | 'stock' | 'usage' | 'deals' | 'transit';

export interface PackFiles {
  plan: File | null;
  stock: File | null;
  usage: File | null;
  deals: File | null;
  transit: File | null;
}

export const EMPTY_PACK_FILES: PackFiles = {
  plan: null,
  stock: null,
  usage: null,
  deals: null,
  transit: null,
};

export type PackPrefs = {
  policyKb: 'default' | null;
  planRange: string;
  usageDays: '30' | '90' | '180';
  priceMonths: '6' | '12' | '24';
  transitDays: '15' | '30' | '60';
};

export const DEFAULT_PACK_PREFS: PackPrefs = {
  policyKb: 'default',
  planRange: 'month',
  usageDays: '90',
  priceMonths: '12',
  transitDays: '30',
};

export function packUiFromFiles(files: PackFiles, policyKb: PackUiState['policyKb']): PackUiState {
  return {
    planReady: Boolean(files.plan),
    qtyReady: Boolean(files.stock && files.usage),
    priceReady: Boolean(files.deals),
    timeReady: Boolean(files.transit),
    policyKb,
  };
}

export function canStartThin(pack: PackUiState): boolean {
  return pack.planReady;
}

export function canStartFull(pack: PackUiState): boolean {
  return pack.planReady && (pack.qtyReady || pack.priceReady || pack.timeReady);
}

const FILE_ACCEPT = '.csv,.txt,.xlsx';

const DOC_ICON = (
  <span className="ico" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </svg>
  </span>
);

const BOOK_ICON = (
  <span className="ico" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3z" />
      <path d="M5 4v16" />
    </svg>
  </span>
);

function gateCopy(pack: PackUiState): { title: string; miss: string; warn: boolean } {
  const policyNote = pack.policyKb ? '含程序合规' : '制度未选用';
  if (!pack.planReady) {
    return { title: '待提交', miss: '需求计划', warn: true };
  }
  const open = [
    pack.qtyReady ? '数量' : null,
    pack.priceReady ? '单价' : null,
    pack.timeReady ? '时点' : null,
  ].filter((item): item is string => Boolean(item));
  const closed = [
    pack.qtyReady ? null : '数量',
    pack.priceReady ? null : '单价',
    pack.timeReady ? null : '时点',
  ].filter((item): item is string => Boolean(item));

  if (open.length === 0) {
    return { title: '待提交', miss: `将只做完整性（及选用的制度）。${policyNote}`, warn: false };
  }
  if (closed.length === 0) {
    return {
      title: '材料已齐',
      miss: pack.policyKb ? '将评估数量、单价、时点与合规。' : '将评估数量、单价、时点。制度未选用。',
      warn: false,
    };
  }
  return {
    title: '待提交',
    miss: `将评估${open.join('、')}。未评估${closed.join('、')}。${policyNote}`,
    warn: false,
  };
}

function sparkiiApi(): {
  getPathForFile?(file: File): string;
  setChatTitle?(sessionId: string, title: string, source?: 'user' | 'agent'): Promise<{ ok: boolean; reason?: 'locked' }>;
  appendError?(rec: { id: string; message: string; source: string; createdAt: number }): Promise<unknown>;
} {
  return ((window as unknown as { sparkii?: {
    getPathForFile?(file: File): string;
    setChatTitle?(sessionId: string, title: string, source?: 'user' | 'agent'): Promise<{ ok: boolean; reason?: 'locked' }>;
    appendError?(rec: { id: string; message: string; source: string; createdAt: number }): Promise<unknown>;
  } }).sparkii ?? {});
}

function electronPath(file: File): string | undefined {
  try {
    const fromApi = sparkiiApi().getPathForFile?.(file);
    if (typeof fromApi === 'string' && fromApi.length > 0) return fromApi;
  } catch {
    // File.path is a test-only fallback after Electron 44 removed it.
  }
  const path = (file as File & { path?: string }).path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function asOfToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

async function readRows(file: File): Promise<Record<string, string>[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) return parseXlsxBuffer(await file.arrayBuffer());
  return parseCsv(await file.text());
}

export async function startPackWorkflow(
  mode: 'thin' | 'full',
  files: PackFiles,
  ctx: { policyKb: PolicyKb; ranges: PackInput['ranges'] },
  actions: AgentSurfaceActions,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  if (!files.plan) return { ok: false, message: '无法解析文件路径' };
  const planPath = electronPath(files.plan);
  if (!planPath) return { ok: false, message: '无法解析文件路径' };
  const documents = [planPath];

  const planRows = await readRows(files.plan);
  const plan = parsePlanTable(planRows, 'upload');
  const facts: FactTables = { stock: [], usage: [], deals: [], transit: [] };
  if (mode === 'full') {
    if (files.stock) facts.stock = parseFactTable('stock', await readRows(files.stock), 'upload');
    if (files.usage) facts.usage = parseFactTable('usage', await readRows(files.usage), 'upload');
    if (files.deals) facts.deals = parseFactTable('deals', await readRows(files.deals), 'upload');
    if (files.transit) facts.transit = parseFactTable('transit', await readRows(files.transit), 'upload');
  }

  const prepared = prepareWorkflowInput({
    plan,
    facts,
    rules: DEFAULT_RULES,
    policyKb: ctx.policyKb,
    ranges: ctx.ranges,
    asOf: asOfToday(),
  }, documents);
  let sessionId: string | undefined;
  try {
    const started = await Promise.resolve(actions.startWorkflow(prepared));
    sessionId = typeof started?.sessionId === 'string' && started.sessionId.length > 0
      ? started.sessionId
      : undefined;
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : '未能开始分析' };
  }
  if (!sessionId) return { ok: false, message: '未能开始分析' };
  const planNo = extractPlanNo(planRows);
  void sparkiiApi().setChatTitle?.(sessionId, procurementSessionTitle(planNo, files.plan.name), 'agent');
  actions.review('evaluation', { stepId: 'review', payload: prepared.evaluation });
  return { ok: true, sessionId };
}

export type PackPageProps = AgentSurfaceProps & {
  files: PackFiles;
  onFile: (slot: PackSlot, file: File) => void;
  prefs: PackPrefs;
  onPrefs: (next: PackPrefs) => void;
};

export function PackPage({ files, onFile, actions, prefs, onPrefs }: PackPageProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { policyKb, planRange, usageDays, priceMonths, transitDays } = prefs;

  const planInput = useRef<HTMLInputElement>(null);
  const stockInput = useRef<HTMLInputElement>(null);
  const usageInput = useRef<HTMLInputElement>(null);
  const dealsInput = useRef<HTMLInputElement>(null);
  const transitInput = useRef<HTMLInputElement>(null);

  const pack = packUiFromFiles(files, policyKb);
  const thinOk = canStartThin(pack);
  const fullOk = canStartFull(pack);
  const factsReady = pack.qtyReady && pack.priceReady && pack.timeReady;
  const gate = gateCopy(pack);

  const onFileChange = (slot: PackSlot) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onFile(slot, file);
  };

  const startCtx = (): { policyKb: PolicyKb; ranges: PackInput['ranges'] } => ({
    policyKb,
    ranges: {
      usageDays: usageDays === '30' || usageDays === '180' ? Number(usageDays) as 30 | 180 : 90,
      priceMonths: priceMonths === '6' || priceMonths === '24' ? Number(priceMonths) as 6 | 24 : 12,
      transitDays: transitDays === '15' || transitDays === '60' ? Number(transitDays) as 15 | 60 : 30,
    },
  });

  const onStart = (mode: 'thin' | 'full') => {
    if (starting) return;
    setStarting(true);
    void startPackWorkflow(mode, files, startCtx(), actions).then((r) => {
      if (r.ok) setError(null);
      else {
        setError(r.message);
        void sparkiiApi().appendError?.({
          id: `procurement-start-${Date.now()}`,
          message: r.message,
          source: '财务采购审核',
          createdAt: Date.now(),
        });
      }
    }).finally(() => setStarting(false));
  };

  const qtyHit = files.stock && files.usage
    ? '已上传库存与领用'
    : files.stock
      ? '已上传库存'
      : files.usage
        ? '已上传领用'
        : null;

  return (
    <div className="procurement">
      <div className="page">
        <h1>财务采购审核</h1>
        <p className="lead">审核需求计划的数量、单价、时点与程序合规。</p>
        <nav className="stepper" aria-label="审核步骤">
          <button className="step on" type="button">
            <span className="n">1</span>
            <span><b>准备</b><em>计划与对照</em></span>
          </button>
          <span className="step-line" />
          <button className="step" type="button">
            <span className="n">2</span>
            <span><b>分析</b><em>生成结论</em></span>
          </button>
          <span className="step-line" />
          <button className="step" type="button">
            <span className="n">3</span>
            <span><b>复核</b><em>确认意见</em></span>
          </button>
        </nav>

        <div className="shell">
          <div className="toolbar">
            <div>
              <div className="title">财务采购审核</div>
              <div className="sub">{pack.planReady ? '计划已上传' : ''}</div>
            </div>
            <div className="toolbar-right">
              <span className={`chip ${pack.qtyReady ? 'on' : 'off'}`}>量</span>
              <span className={`chip ${pack.priceReady ? 'on' : 'off'}`}>价</span>
              <span className={`chip ${pack.timeReady ? 'on' : 'off'}`}>时</span>
              <span className={`chip ${pack.policyKb ? 'on' : 'off'}`}>合规</span>
            </div>
          </div>

          <div className="flow">
            <div className="board">
              <div className="rail" aria-hidden="true" />
              <div className="stages">
                <section className={`stage ${pack.planReady ? 'ok' : 'wait'}`}>
                  <div className="dot">1</div>
                  <div className={`subject ${pack.planReady ? 'ready' : ''}`}>
                    {DOC_ICON}
                    <div className="subject-top">
                      <div>
                        <h2>物资需求计划</h2>
                        <p>{pack.planReady ? '可再次获取或补充文件。' : '从 OA 获取，或上传文件。'}</p>
                      </div>
                      <span className={`status ${pack.planReady ? 'on' : 'wait'}`}>
                        {pack.planReady ? '已上传' : '未提交'}
                      </span>
                    </div>
                    <div>
                      <div className="hits">
                        {pack.planReady ? <div className="hit file"><b>文件</b>已上传需求计划</div> : null}
                      </div>
                      <div className="acts">
                        <SelectMenu
                          variant="plain"
                          className="range"
                          aria-label="计划范围"
                          value={planRange}
                          options={[
                            { value: 'month', label: '本月' },
                            { value: 'last', label: '上月' },
                            { value: 'id', label: '指定单号' },
                          ]}
                          onChange={(next) => onPrefs({ ...prefs, planRange: next })}
                        />
                        <button className="act pull" type="button" disabled>从 OA 获取</button>
                        <button className="act" type="button" onClick={() => planInput.current?.click()}>
                          {pack.planReady ? '更换文件' : '上传'}
                        </button>
                        <input
                          ref={planInput}
                          type="file"
                          accept={FILE_ACCEPT}
                          hidden
                          aria-label="上传计划"
                          onChange={onFileChange('plan')}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <section className={`stage ${factsReady ? 'ok' : 'wait'}`}>
                  <div className="dot">2</div>
                  <div className="stage-bar">
                    <p><b>对照数据</b>　库存、成交、在途。系统获取或上传均可。</p>
                    <button className="btn primary" type="button" disabled>获取对照数据</button>
                  </div>
                  <div className="conds">
                    <div className={`cond ${pack.qtyReady ? 'ready' : ''}`}>
                      <div className="cond-top">
                        <span className="mark">量</span>
                        <span className={`status ${pack.qtyReady ? 'on' : 'wait'}`}>{pack.qtyReady ? '已上传' : '未提交'}</span>
                      </div>
                      <h3>数量</h3>
                      <p className="need">对照库存与领用。</p>
                      <div className="hits">
                        {qtyHit ? <div className="hit file"><b>文件</b>{qtyHit}</div> : null}
                      </div>
                      <div className="acts">
                        <SelectMenu
                          variant="plain"
                          className="range"
                          aria-label="领用范围"
                          value={usageDays}
                          options={[
                            { value: '30', label: '领用 30 天' },
                            { value: '90', label: '领用 90 天' },
                            { value: '180', label: '领用 180 天' },
                          ]}
                          onChange={(next) => onPrefs({ ...prefs, usageDays: next as PackPrefs['usageDays'] })}
                        />
                        <button className="act pull" type="button" disabled>从库存获取</button>
                        <button className="act" type="button" onClick={() => stockInput.current?.click()}>
                          {files.stock ? '更换库存' : '上传库存'}
                        </button>
                        <button className="act" type="button" onClick={() => usageInput.current?.click()}>
                          {files.usage ? '更换领用' : '上传领用'}
                        </button>
                        <input ref={stockInput} type="file" accept={FILE_ACCEPT} hidden aria-label="上传库存" onChange={onFileChange('stock')} />
                        <input ref={usageInput} type="file" accept={FILE_ACCEPT} hidden aria-label="上传领用" onChange={onFileChange('usage')} />
                      </div>
                    </div>

                    <div className={`cond ${pack.priceReady ? 'ready' : ''}`}>
                      <div className="cond-top">
                        <span className="mark">价</span>
                        <span className={`status ${pack.priceReady ? 'on' : 'wait'}`}>{pack.priceReady ? '已上传' : '未提交'}</span>
                      </div>
                      <h3>单价</h3>
                      <p className="need">对照本厂成交。</p>
                      <div className="hits">
                        {pack.priceReady ? <div className="hit file"><b>文件</b>已上传历史成交</div> : null}
                      </div>
                      <div className="acts">
                        <SelectMenu
                          variant="plain"
                          className="range"
                          aria-label="成交范围"
                          value={priceMonths}
                          options={[
                            { value: '6', label: '成交 6 个月' },
                            { value: '12', label: '成交 12 个月' },
                            { value: '24', label: '成交 24 个月' },
                          ]}
                          onChange={(next) => onPrefs({ ...prefs, priceMonths: next as PackPrefs['priceMonths'] })}
                        />
                        <button className="act pull" type="button" disabled>从 U8 获取</button>
                        <button className="act" type="button" onClick={() => dealsInput.current?.click()}>
                          {pack.priceReady ? '更换文件' : '上传'}
                        </button>
                        <input ref={dealsInput} type="file" accept={FILE_ACCEPT} hidden aria-label="上传成交" onChange={onFileChange('deals')} />
                      </div>
                    </div>

                    <div className={`cond ${pack.timeReady ? 'ready' : ''}`}>
                      <div className="cond-top">
                        <span className="mark">时</span>
                        <span className={`status ${pack.timeReady ? 'on' : 'wait'}`}>{pack.timeReady ? '已上传' : '未提交'}</span>
                      </div>
                      <h3>时点</h3>
                      <p className="need">对照在途订单。</p>
                      <div className="hits">
                        {pack.timeReady ? <div className="hit file"><b>文件</b>已上传在途采购</div> : null}
                      </div>
                      <div className="acts">
                        <SelectMenu
                          variant="plain"
                          className="range"
                          aria-label="在途范围"
                          value={transitDays}
                          options={[
                            { value: '15', label: '在途 15 天' },
                            { value: '30', label: '在途 30 天' },
                            { value: '60', label: '在途 60 天' },
                          ]}
                          onChange={(next) => onPrefs({ ...prefs, transitDays: next as PackPrefs['transitDays'] })}
                        />
                        <button className="act pull" type="button" disabled aria-label="获取在途">从 OA 获取</button>
                        <button className="act" type="button" onClick={() => transitInput.current?.click()}>
                          {pack.timeReady ? '更换文件' : '上传'}
                        </button>
                        <input ref={transitInput} type="file" accept={FILE_ACCEPT} hidden aria-label="上传在途" onChange={onFileChange('transit')} />
                      </div>
                    </div>
                  </div>
                </section>

                <section className={`stage ${pack.policyKb ? 'ok' : ''}`}>
                  <div className="dot">3</div>
                  <div className={`policy ${pack.policyKb ? 'ready' : ''}`}>
                    {BOOK_ICON}
                    <div className="policy-top">
                      <div>
                        <h2>制度</h2>
                        <p>{pack.policyKb ? '按所选制度审核程序合规。' : '不选用则只做完整性检查。'}</p>
                      </div>
                      <span className={`status ${pack.policyKb ? 'on' : 'wait'}`}>
                        {pack.policyKb ? '已选用' : '未选用'}
                      </span>
                    </div>
                    <label>
                      <SelectMenu
                        variant="plain"
                        className="kb"
                        aria-label="本次用哪套制度"
                        value={pack.policyKb ?? ''}
                        options={[
                          { value: 'default', label: '采购制度（默认）' },
                          { value: '', label: '不使用' },
                        ]}
                        onChange={(next) => onPrefs({ ...prefs, policyKb: next === 'default' ? 'default' : null })}
                      />
                    </label>
                  </div>
                </section>
              </div>
            </div>
          </div>

          <div className="gate">
            <div>
              <b>{gate.title}</b>
              <p className={`miss ${gate.warn ? 'warn' : ''}`}>{gate.miss}</p>
              {error ? <p className="miss warn" role="alert">{error}</p> : null}
            </div>
            <div className="gate-actions">
              <button className="btn" type="button" disabled={!thinOk || starting} onClick={() => onStart('thin')}>完整性审核</button>
              <button className="btn primary" type="button" disabled={!fullOk || starting} onClick={() => onStart('full')}>开始分析</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
