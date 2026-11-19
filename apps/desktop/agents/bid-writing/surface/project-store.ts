/**
 * project.json data model + CRUD over the generic P1 workspace file IPC.
 * Agent-local logic — no platform changes, no business branch in platform core.
 * All reads/writes are fenced by the P1 service (Workspace Admission + audit).
 */
import type { SparkiiApi, WorkspaceFileResult } from '../../../src/types/sparkii-api.js';

export interface Chapter {
  id: string;
  title: string;
  file?: string;
  blockId?: string;
  status?: 'todo' | 'editing' | 'done';
}

export interface KnowledgeBase {
  datasetId: string;
  name: string;
}

export interface ProjectFile {
  id: string;
  name: string;
  client?: string | null;
  deadline?: string | null;
  projectCode?: string | null;
  template?: string | null;
  /**
   * setup    = project skeleton created, user has NOT confirmed writing yet;
   *            no LLM turn has been dispatched. Reference info can be added.
   * drafting = user confirmed; the collaborative writing session has started.
   * exported = final DOCX was compiled.
   */
  status: 'setup' | 'drafting' | 'exported';
  workspacePath: string;
  knowledgeBases: KnowledgeBase[];
  chapters: Chapter[];
  progress: { done: number; total: number };
  version: number;
  createdAt: number;
  updatedAt: number;
}

export const PROJECT_FILE = 'project.json';

const DEFAULT_CHAPTERS: Chapter[] = [
  { id: '1', title: '投标函', file: '01-投标函.md', status: 'todo' },
  { id: '2', title: '法定代表人授权书', file: '02-授权书.md', status: 'todo' },
  { id: '3', title: '技术方案', file: '03-技术方案.md', status: 'todo' },
  { id: '4', title: '商务报价', file: '04-商务报价.md', status: 'todo' },
  { id: '5', title: '资质证明', file: '05-资质证明.md', status: 'todo' },
];

function api(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

export function newProject(input: {
  id: string;
  name: string;
  workspacePath: string;
  client?: string;
  deadline?: string;
  projectCode?: string;
  template?: string;
  knowledgeBases?: KnowledgeBase[];
}): ProjectFile {
  const now = Date.now();
  return {
    id: input.id,
    name: input.name,
    client: input.client ?? null,
    deadline: input.deadline ?? null,
    projectCode: input.projectCode ?? null,
    template: input.template ?? null,
    status: 'setup',
    workspacePath: input.workspacePath,
    knowledgeBases: input.knowledgeBases ?? [],
    chapters: DEFAULT_CHAPTERS.map((c) => ({ ...c })),
    progress: { done: 0, total: DEFAULT_CHAPTERS.length },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export async function readProject(sessionId: string): Promise<ProjectFile | null> {
  const r: WorkspaceFileResult = await api().workspaceRead({ sessionId, path: PROJECT_FILE });
  if (!r.ok || typeof r.content !== 'string') return null;
  try {
    return JSON.parse(r.content) as ProjectFile;
  } catch {
    return null;
  }
}

export async function writeProject(sessionId: string, project: ProjectFile): Promise<boolean> {
  const next = { ...project, updatedAt: Date.now() };
  const r: WorkspaceFileResult = await api().workspaceWrite({
    sessionId,
    path: PROJECT_FILE,
    content: JSON.stringify(next, null, 2),
  });
  return r.ok;
}

/** Ensure the workspace skeleton (input/output/manuscript/figures/versions/final) exists. */
export async function ensureSkeleton(sessionId: string): Promise<void> {
  const dirs = [
    'input',
    'output',
    'output/manuscript',
    'output/figures',
    'output/versions',
    'output/final',
  ];
  // Independent paths — mkdir is recursive in the fenced IPC, so order does not
  // matter. Parallel cuts six serial admission+audit round trips on project
  // creation (perf; no change to path validation or audit semantics).
  await Promise.all(dirs.map((path) => api().workspaceMkdir({ sessionId, path })));
}

export async function readChapter(sessionId: string, file: string): Promise<string> {
  const r: WorkspaceFileResult = await api().workspaceRead({
    sessionId,
    path: `output/manuscript/${file}`,
  });
  return r.ok && typeof r.content === 'string' ? r.content : '';
}

export async function writeChapter(sessionId: string, file: string, content: string): Promise<boolean> {
  const r: WorkspaceFileResult = await api().workspaceWrite({
    sessionId,
    path: `output/manuscript/${file}`,
    content,
  });
  return r.ok;
}
