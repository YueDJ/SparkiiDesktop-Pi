import { useState } from 'react';

interface Provider {
  url: string;
  source: string;
  models: string[];
}

const PROVIDERS: Record<string, Provider> = {
  '本地 Ollama': { url: 'http://127.0.0.1:11434/v1', source: '本地', models: ['qwen2.5', 'llama3.1'] },
  '本地 vLLM': { url: 'http://127.0.0.1:8000/v1', source: '本地', models: ['qwen2.5-72b', 'glm-4-9b'] },
  '云端 OpenAI 兼容': { url: 'https://api.example.com/v1', source: '云端', models: ['gpt-4o-mini', 'gpt-4o'] },
  DeepSeek: { url: 'https://api.deepseek.com/v1', source: '云端', models: ['deepseek-chat', 'deepseek-reasoner'] },
};

interface ModelState { label: string; status: string; cls: '' | 'ok' | 'fail' | 'wait'; }

function buildModels(providerName: string): Record<string, ModelState> {
  const p = PROVIDERS[providerName] ?? PROVIDERS['本地 Ollama'];
  const out: Record<string, ModelState> = {};
  for (const m of p.models) out[m] = { label: `${m} · ${p.source}`, status: '未测试', cls: '' };
  return out;
}

const PANES = ['llm', 'data', 'runtime', 'approval', 'appearance'] as const;
type Pane = (typeof PANES)[number];
const PANE_LABELS: Record<Pane, string> = {
  llm: '大模型连接', data: '数据与隐私', runtime: '智能体与运行', approval: '审批与安全', appearance: '外观与语言',
};

export function SettingsView() {
  const [pane, setPane] = useState<Pane>('llm');
  const [provider, setProvider] = useState('本地 Ollama');
  const [info, setInfo] = useState('当前节点:本地 Ollama · 未拉取');
  const [models, setModels] = useState<Record<string, ModelState>>(() => buildModels('本地 Ollama'));
  const [busy, setBusy] = useState(false);

  const switchProvider = (name: string) => {
    setProvider(name);
    setModels(buildModels(name));
    setInfo(`当前节点:${name} · 未拉取`);
  };

  const fetchModels = () => {
    if (busy) return;
    setBusy(true);
    setTimeout(() => {
      setModels(buildModels(provider));
      setInfo(`当前节点:${provider} · 已拉取 ${PROVIDERS[provider]?.models.length ?? 0} 个模型`);
      setBusy(false);
    }, 800);
  };

  const testAll = () => {
    if (busy) return;
    setBusy(true);
    const name = provider;
    setModels((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) next[k] = { ...next[k], status: '连接中…', cls: 'wait' };
      return next;
    });
    setTimeout(() => {
      setModels((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k, i) => {
          const fail = k === 'glm-4-9b';
          next[k] = {
            ...next[k],
            status: fail ? '连接失败 · 超时' : `已连接 · ${['240ms', '86ms', '180ms', '310ms'][i % 4]}`,
            cls: fail ? 'fail' : 'ok',
          };
        });
        return next;
      });
      setInfo(`当前节点:${name} · 测试完成`);
      setBusy(false);
    }, 1000);
  };

  const modelNames = Object.keys(models);

  return (
    <div className="grid-2" style={{ gridTemplateColumns: '200px 1fr', alignItems: 'start' }}>
      <div className="card" style={{ padding: 10 }}>
        {PANES.map((p) => (
          <button key={p} type="button" className={`agent ${pane === p ? 'on' : ''}`} onClick={() => setPane(p)}>
            <span className="dot dot-idle" />{PANE_LABELS[p]}
          </button>
        ))}
      </div>
      <div className="card" style={{ padding: '18px 20px' }}>
        {pane === 'llm' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>大模型连接</h3>
            <div className="muted" style={{ marginBottom: 6 }}>配置模型端点与任务路由;数据默认不出本机</div>
            <div className="set-row">
              <span>服务商</span>
              <select className="set-field" value={provider} onChange={(e) => switchProvider(e.target.value)}>
                {Object.keys(PROVIDERS).map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div className="set-row"><span>接口地址(Base URL)</span><input className="set-field" value={PROVIDERS[provider]?.url ?? ''} readOnly /></div>
            <div className="set-row"><span>API Key</span><input className="set-field" type="password" defaultValue="sk-••••••••••" /></div>
            <div className="set-row"><span>默认模型</span><input className="set-field" value={modelNames[0] ?? ''} readOnly /></div>
            <div className="set-row">
              <span>任务路由(按任务选模型)</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280 }}>
                {['对话 chat', '抽取 extract', '报告 report', '默认 default'].map((label) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="kv" style={{ width: 84 }}>{label}</span>
                    <select className="set-field route-select" style={{ flex: 1 }}>
                      {modelNames.map((m) => <option key={m}>{m}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={fetchModels} disabled={busy}>{busy ? '处理中…' : '拉取模型列表'}</button>
              <button type="button" className="btn" onClick={testAll} disabled={busy}>{busy ? '测试中…' : '测试连接'}</button>
              <button type="button" className="btn primary">保存</button>
            </div>
            <h3 style={{ margin: '18px 0 4px' }}>模型状态 <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{info}</span></h3>
            <div className="muted" style={{ marginBottom: 6 }}>测试连接后展示每个模型的可达状态</div>
            {modelNames.map((m) => (
              <div key={m} className="set-row">
                <span>{models[m].label}</span>
                <span className={`mstat ${models[m].cls}`}>{models[m].status}</span>
              </div>
            ))}
          </>
        )}
        {pane === 'data' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>数据与隐私</h3>
            <div className="set-row"><span>数据目录</span><input className="set-field" defaultValue="C:\SparkiiData\admin" /></div>
            <div className="set-row"><span>本地加密落盘</span><span className="switch on" /></div>
            <div className="set-row"><span>审计记录(只追加)</span><span className="switch on" /></div>
          </>
        )}
        {pane === 'runtime' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>智能体与运行</h3>
            <div className="set-row"><span>并行智能体上限</span><select className="set-field" defaultValue="4"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
            <div className="set-row"><span>超出上限时排队</span><span className="switch on" /></div>
            <div className="set-row"><span>崩溃自动恢复</span><span className="switch on" /></div>
            <div className="set-row"><span>日志级别</span><select className="set-field" defaultValue="信息"><option>信息</option><option>调试</option><option>警告</option></select></div>
          </>
        )}
        {pane === 'approval' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>审批与安全</h3>
            <div className="set-row"><span>审批默认超时(秒)</span><input className="set-field" style={{ width: 120 }} defaultValue="120" /></div>
            <div className="set-row"><span>高风险操作二次确认</span><span className="switch on" /></div>
            <div className="set-row"><span>超时自动拒绝</span><span className="switch on" /></div>
            <div className="set-row"><span>当前角色</span><span className="kv">审核员(可批准:合同审核导出、状态变更)</span></div>
          </>
        )}
        {pane === 'appearance' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>外观与语言</h3>
            <div className="set-row"><span>主题</span><select className="set-field"><option>浅色</option><option>深色</option></select></div>
            <div className="set-row"><span>界面语言</span><select className="set-field"><option>简体中文</option><option>English</option></select></div>
          </>
        )}
      </div>
    </div>
  );
}
