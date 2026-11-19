/**
 * Block-level three-way merge for manuscript text (product §8.1, I4).
 *
 * Manuscript blocks are delimited by an HTML-comment anchor:
 *   <!-- block:blk-3-2 -->
 *   ...block content...
 * A block has a stable id. AI edits are block-scoped patches (only the target
 * block changes), never whole-chapter rewrites. Merge inputs:
 *   base    — snapshot at versions/vN when the AI patch was produced
 *   current — the on-disk file now (may include user hand edits)
 *   patch   — AI-produced new content for one or more blocks
 *
 * Rules:
 *  - if a block is unchanged in current vs base, apply the patch block wholesale;
 *  - if a block changed in current AND the patch also changes it → CONFLICT:
 *    keep both sides, marker for the user to arbitrate (never silently overwrite);
 *  - blocks untouched by the patch stay as current;
 *  - blocks present only in base but deleted in current stay deleted unless patched.
 *
 * Pure functions, no I/O — trivially testable.
 */
export interface Block {
  id: string;
  content: string;
}

export interface MergeOutcome {
  merged: string;
  conflicts: string[];
  applied: string[];
}

const RE = /<!--\s*block:([^\s>]+)\s*-->/g;

export function parseBlocks(text: string): Block[] {
  const matches: Array<{ id: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(text)) !== null) {
    matches.push({ id: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  const blocks: Block[] = [];
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    blocks.push({ id: matches[i].id, content: text.slice(matches[i].bodyStart, end) });
  }
  return blocks;
}

export function serializeBlocks(blocks: Block[]): string {
  return blocks.map((b) => `<!-- block:${b.id} -->\n${b.content}`).join('\n\n') + '\n';
}

export function addBlockAnchors(text: string, idFor: (index: number) => string): string {
  // Wrap each non-empty paragraph as a block (best-effort for legacy text).
  const paragraphs = text.split(/\n\s*\n/);
  const blocks: Block[] = paragraphs.map((p, i) => ({ id: idFor(i), content: p }));
  return serializeBlocks(blocks);
}

function byId(blocks: Block[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of blocks) map.set(b.id, b.content);
  return map;
}

/**
 * Three-way merge. `patch` is a full text with block anchors for the blocks
 * the AI changed (other blocks may be omitted).
 */
export function threeWayMerge(base: string, current: string, patch: string): MergeOutcome {
  const baseMap = byId(parseBlocks(base));
  const curMap = byId(parseBlocks(current));
  const patchMap = byId(parseBlocks(patch));
  const conflicts: string[] = [];
  const applied: string[] = [];

  const result = new Map<string, string>(curMap);

  for (const [id, patchContent] of patchMap) {
    const baseContent = baseMap.get(id);
    const curContent = curMap.get(id);
    const baseHad = baseMap.has(id);
    const patchEqualsBase = baseHad && baseContent === patchContent;

    if (patchEqualsBase) continue; // AI didn't actually change this block.

    if (curContent === undefined) {
      // Block not in current (new or deleted) — AI adds it.
      result.set(id, patchContent);
      applied.push(id);
      continue;
    }

    const userChanged = !baseHad || baseContent !== curContent;
    if (userChanged && curContent !== patchContent) {
      // Both changed differently — conflict, keep both.
      result.set(id,
        `<<<<<<< current\n${curContent}>>>>>>> current\n=======\n${patchContent}======= AI`);
      conflicts.push(id);
    } else {
      result.set(id, patchContent);
      applied.push(id);
    }
  }

  // Preserve original order: current order first, then any new patched blocks.
  const order: string[] = parseBlocks(current).map((b) => b.id);
  for (const id of patchMap.keys()) if (!order.includes(id)) order.push(id);

  const mergedBlocks: Block[] = order
    .filter((id) => result.has(id))
    .map((id) => ({ id, content: result.get(id)! }));
  return { merged: serializeBlocks(mergedBlocks), conflicts, applied };
}
