import { SparkiiOntoGraph } from './graph.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).map(asRecord);
}

/**
 * SparkiiOnto 其余只读能力族（连接器层，模型不可见，D3）。
 *
 * 覆盖分析、时间、词汇、审计、标注读、记忆读与 markdown 读。这些能力暂不进
 * `tools.ts` 的工具清单，仅作为类型化方法供平台后续功能使用；与工具面共用同一
 * `SparkiiOntoGraph` 客户端（baseUrl 校验、凭据、超时与 `/info` 能力协商）。
 *
 * 说明：`vocabularyConcepts` / `vocabularyHierarchy` 的 Explorer 端点把 `scheme`
 * 声明为必填查询参数，因此这两个方法把 `scheme` 作为必填入参（与端点一致）。
 */
export class SparkiiOntoReadFamilies extends SparkiiOntoGraph {
  /** 图分析（centrality / community / connectivity）；`metrics` 为逗号分隔的可选裁剪。 */
  async analytics(metrics?: string): Promise<unknown> {
    await this.ensureGraph();
    const params = new URLSearchParams();
    if (metrics) params.set('metrics', metrics);
    const qs = params.toString();
    return this.requestJson(`${this.address}/api/analytics${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
  }

  /** 时间有效边界；空图谱时两端均为 null。 */
  async temporalBounds(): Promise<{ min: string | null; max: string | null }> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/temporal/bounds`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const rec = asRecord(payload);
    return {
      min: typeof rec.min === 'string' ? rec.min : null,
      max: typeof rec.max === 'string' ? rec.max : null,
    };
  }

  /** 某时刻（ISO 时间或年份）的活跃节点快照。 */
  async temporalSnapshot(at: string): Promise<unknown> {
    await this.ensureGraph();
    return this.requestJson(`${this.address}/api/temporal/snapshot?at=${encodeURIComponent(at)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
  }

  /** 列出词汇方案（ConceptScheme）。 */
  async vocabularySchemes(): Promise<Array<Record<string, unknown>>> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/vocabulary/schemes`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    return asRecords(payload);
  }

  /** 列出某词汇方案下的概念；`scheme` 为 ConceptScheme URI（端点必填）。 */
  async vocabularyConcepts(scheme: string): Promise<Array<Record<string, unknown>>> {
    await this.ensureGraph();
    const payload = await this.requestJson(
      `${this.address}/api/vocabulary/concepts?scheme=${encodeURIComponent(scheme)}`,
      { method: 'GET', headers: this.authHeaders() },
    );
    return asRecords(payload);
  }

  /** 取某词汇方案的层级（带 children 的 ConceptNode 树）。 */
  async vocabularyHierarchy(scheme: string): Promise<unknown> {
    await this.ensureGraph();
    return this.requestJson(`${this.address}/api/vocabulary/hierarchy?scheme=${encodeURIComponent(scheme)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
  }

  /** 列出审计记录；当前只读凭据缺 `audit:read`，会透出 403（CONNECTOR_DENIED）。 */
  async auditEntries(): Promise<Array<Record<string, unknown>>> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/v1/onto/audit`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    return asRecords(payload);
  }

  /** 列出节点标注（可按 node_id 过滤）。 */
  async annotations(nodeId?: string): Promise<Array<Record<string, unknown>>> {
    await this.ensureGraph();
    const params = new URLSearchParams();
    if (nodeId) params.set('node_id', nodeId);
    const qs = params.toString();
    const payload = await this.requestJson(`${this.address}/api/annotations${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    return asRecords(payload);
  }

  /** 列出记忆；未配置 AgentMemory 时端点返回 503。 */
  async memories(): Promise<Array<Record<string, unknown>>> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/memories`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const items = asRecord(payload).items;
    return Array.isArray(items) ? asRecords(items) : asRecords(payload);
  }

  /** 读取 markdown 资源（kind ∈ context-node | agent-memory）。 */
  async markdown(kind: string, resourceId: string): Promise<unknown> {
    await this.ensureGraph();
    return this.requestJson(
      `${this.address}/api/markdown/${encodeURIComponent(kind)}/${encodeURIComponent(resourceId)}`,
      { method: 'GET', headers: this.authHeaders() },
    );
  }
}
