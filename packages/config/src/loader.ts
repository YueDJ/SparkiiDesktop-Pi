import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseProfileManifest } from './schema.js';
import { collectSkillDirFiles, loadSkillsFromDir } from './skills.js';
import type { ResolvedProfile } from './types.js';

export class ProfileError extends Error {
  constructor(public code: 'PROFILE_INVALID' | 'SIGNATURE_INVALID' | 'PROFILE_NOT_FOUND', message: string) {
    super(message);
  }
}

const read = async (dir: string, rel: string) => readFile(join(dir, rel), 'utf8').catch(() => {
  throw new ProfileError('PROFILE_INVALID', `missing file: ${rel}`);
});

export async function loadProfile(
  dir: string,
  opts: { publicKey?: string; allowUnsigned?: boolean } = {},
): Promise<ResolvedProfile> {
  const manifestRaw = await read(dir, 'manifest.yaml');
  let manifest;
  try { manifest = parseProfileManifest(parseYaml(manifestRaw)); }
  catch (e) { throw new ProfileError('PROFILE_INVALID', `manifest invalid: ${(e as Error).message}`); }

  const files: Record<string, Buffer> = { 'manifest.yaml': Buffer.from(manifestRaw) };
  const toolsRaw = await read(dir, 'agent/tools.yaml');
  const workflowRaw = await read(dir, 'agent/workflow.yaml');
  const pagesRaw = await read(dir, 'ui/pages/home.json');
  const themeRaw = await read(dir, 'ui/theme.yaml');
  const rolesRaw = await read(dir, 'security/roles.yaml');
  const approvalRaw = await read(dir, 'security/approval.yaml');
  Object.assign(files, {
    'agent/tools.yaml': Buffer.from(toolsRaw),
    'agent/workflow.yaml': Buffer.from(workflowRaw), 'ui/pages/home.json': Buffer.from(pagesRaw),
    'ui/theme.yaml': Buffer.from(themeRaw), 'security/roles.yaml': Buffer.from(rolesRaw),
    'security/approval.yaml': Buffer.from(approvalRaw),
  });

  const skillRoot = join(dir, 'agent', 'skills');
  const skillResult = await loadSkillsFromDir(skillRoot);
  const skills = skillResult.skills;
  const prompts: Record<string, string> = {};
  for (const s of skills) {
    prompts[s.name] = s.content;
  }
  const skillFiles = await collectSkillDirFiles(skillRoot);
  for (const [rel, buf] of Object.entries(skillFiles)) {
    files[`agent/skills/${rel}`] = buf;
  }

  const systemPromptRaw = await readFile(join(dir, 'agent', 'prompts', 'system.md'), 'utf8').catch(() => null);
  if (systemPromptRaw !== null) {
    files['agent/prompts/system.md'] = Buffer.from(systemPromptRaw);
    prompts.system = systemPromptRaw;
  }

  const toolsCfg = parseYaml(toolsRaw) as { tools: string[] };
  const themeCfg = parseYaml(themeRaw) as { file: string };
  const tokens = await read(dir, `ui/${themeCfg.file}`);
  files[`ui/${themeCfg.file}`] = Buffer.from(tokens);
  const corpusRaw = await read(dir, 'agent/knowledge/corpus.json');
  files['agent/knowledge/corpus.json'] = Buffer.from(corpusRaw);
  const knowledge = JSON.parse(corpusRaw) as Array<{ id: string; text: string }>;

  if (opts.publicKey) {
    const { verifyFiles } = await import('./integrity.js');
    const sig = await read(dir, 'manifest.sig');
    if (!verifyFiles(files, opts.publicKey, sig.trim())) {
      throw new ProfileError('SIGNATURE_INVALID', 'profile signature mismatch');
    }
  } else if (!opts.allowUnsigned) {
    throw new ProfileError('SIGNATURE_INVALID', 'unsigned profile and publicKey not provided');
  }

  return {
    manifest,
    agent: { skills, tools: toolsCfg.tools, prompts, workflow: parseYaml(workflowRaw) as Record<string, unknown>, knowledge },
    ui: { pages: { home: JSON.parse(pagesRaw) }, theme: themeCfg },
    security: { roles: parseYaml(rolesRaw)?.roles ?? [], approval: parseYaml(approvalRaw) },
  };
}
