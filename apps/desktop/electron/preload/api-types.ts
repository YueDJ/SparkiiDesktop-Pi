export interface SparkiiApi {
  login(username: string, password: string): Promise<{ userId: string; roles: string[] }>;
  getProfile(): Promise<unknown>;
  chooseDocument(): Promise<{ path?: string }>;
  runWorkflow(id: string, input: Record<string, unknown>): Promise<{ ok: boolean }>;
  prompt(text: string): Promise<{ ok: boolean }>;
  listPendingApprovals(): Promise<unknown[]>;
  decideApproval(id: string, approved: boolean, note?: string): Promise<unknown>;
  queryAudit(filter: object): Promise<unknown[]>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}
