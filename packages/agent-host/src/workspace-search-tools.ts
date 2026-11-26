import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  getAgentDir,
  truncateHead,
  truncateLine,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isPlatformReservedPath } from "./workspace-guard.js";

const RESERVED_DIRECTORY = ".sparkii";
const DEFAULT_GREP_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

function isReservedDirectory(name: string): boolean {
  return name.toLowerCase() === RESERVED_DIRECTORY;
}

const RESERVED_DIRECTORY_VARIANTS = Array.from(new Set(
  Array.from({ length: 2 ** RESERVED_DIRECTORY.length }, (_, mask) =>
    [...RESERVED_DIRECTORY].map((character, index) =>
      mask & (1 << index) ? character.toUpperCase() : character).join("")),
));

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function managedSearchToolPath(name: string): string {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const managed = join(getAgentDir(), "bin", executable);
  return existsSync(managed) ? managed : executable;
}

async function guardedGlob(
  pattern: string,
  root: string,
  options: { limit: number },
): Promise<string[]> {
  const args = ["--glob", "--color=never", "--hidden"];
  // fd prunes excluded directories before visiting their children. Its exclude
  // globs are case-sensitive, so enumerate the casing variants used by the
  // platform guard rather than filtering after traversal.
  for (const variant of RESERVED_DIRECTORY_VARIANTS) args.push("--exclude", variant);
  let insideGitRepo = false;
  for (let current = root;;) {
    if (await access(join(current, ".git")).then(() => true, () => false)) {
      insideGitRepo = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!insideGitRepo) args.push("--no-require-git");
  args.push("--max-results", String(options.limit));
  let effectivePattern = pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      effectivePattern = `**/${pattern}`;
    }
    if (process.platform === "win32") effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
  }
  args.push("--", effectivePattern, root);

  return new Promise((resolveResults, reject) => {
    const child = spawn(managedSearchToolPath("fd"), args, { stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const results: string[] = [];
    let stderr = "";
    lines.on("line", (line) => {
      const value = line.replace(/\r$/, "").trim();
      if (value) results.push(value);
    });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      lines.close();
      reject(new Error(`Failed to run fd: ${error.message}`));
    });
    child.on("close", (code) => {
      lines.close();
      if (code !== 0 && !results.length) {
        reject(new Error(stderr.trim() || `fd exited with code ${code}`));
      } else {
        resolveResults(results);
      }
    });
  });
}

type GrepMatch = { filePath: string; lineNumber: number; lineText?: string };

async function executeGrep(
  cwd: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined }> {
  const pattern = String(params.pattern ?? "");
  const searchPath = resolve(cwd, String(params.path ?? "."));
  const glob = typeof params.glob === "string" ? params.glob : undefined;
  const context = typeof params.context === "number" && params.context > 0 ? params.context : 0;
  const limit = Math.max(1, typeof params.limit === "number" ? params.limit : DEFAULT_GREP_LIMIT);
  const searchStat = await stat(searchPath);
  const isDirectory = searchStat.isDirectory();
  const formatPath = (filePath: string) => {
    if (isDirectory) {
      const path = posixPath(relative(searchPath, filePath));
      if (path && !path.startsWith("..")) return path;
    }
    return basename(filePath);
  };

  const args = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase === true) args.push("--ignore-case");
  if (params.literal === true) args.push("--fixed-strings");
  if (glob) args.push("--glob", glob);
  // Keep these after the caller's glob: ripgrep applies later globs last, so a
  // positive include can never re-open a retained directory.
  args.push("--iglob", "!**/.sparkii/**", "--iglob", "!**/.sparkii");
  args.push("--", pattern, searchPath);

  return new Promise((resolve, reject) => {
    const child = spawn(managedSearchToolPath("rg"), args, { stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const matches: GrepMatch[] = [];
    let stderr = "";
    let settled = false;
    let matchLimitReached = false;
    let aborted = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    lines.on("line", (line) => {
      if (!line.trim() || matches.length >= limit) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type !== "match") return;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (typeof filePath !== "string" || typeof lineNumber !== "number") return;
      // Defense in depth for context reads; ripgrep has already been told not
      // to scan these paths, so reserved contents never reach this collection.
      if (isPlatformReservedPath(filePath)) return;
      matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
      if (matches.length >= limit) {
        matchLimitReached = true;
        child.kill();
      }
    });
    child.on("error", (error) => {
      lines.close();
      settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
    });
    child.on("close", async (code) => {
      lines.close();
      if (aborted) {
        settle(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!matchLimitReached && code !== 0 && code !== 1) {
        settle(() => reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`)));
        return;
      }
      try {
        const outputLines: string[] = [];
        const fileCache = new Map<string, string[]>();
        let linesTruncated = false;
        for (const match of matches) {
          if (context === 0 && match.lineText !== undefined) {
            const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
            const truncated = truncateLine(sanitized);
            if (truncated.wasTruncated) linesTruncated = true;
            outputLines.push(`${formatPath(match.filePath)}:${match.lineNumber}: ${truncated.text}`);
            continue;
          }
          let fileLines = fileCache.get(match.filePath);
          if (!fileLines) {
            try {
              fileLines = (await readFile(match.filePath, "utf8")).replace(/\r\n/g, "\n").split("\n");
            } catch {
              fileLines = [];
            }
            fileCache.set(match.filePath, fileLines);
          }
          if (!fileLines.length) {
            outputLines.push(`${formatPath(match.filePath)}:${match.lineNumber}: (unable to read file)`);
            continue;
          }
          const start = context > 0 ? Math.max(1, match.lineNumber - context) : match.lineNumber;
          const end = Math.min(fileLines.length, match.lineNumber + context);
          for (let current = start; current <= end; current++) {
            const truncated = truncateLine((fileLines[current - 1] ?? "").replace(/\r/g, ""));
            if (truncated.wasTruncated) linesTruncated = true;
            outputLines.push(current === match.lineNumber
              ? `${formatPath(match.filePath)}:${current}: ${truncated.text}`
              : `${formatPath(match.filePath)}-${current}- ${truncated.text}`);
          }
        }
        if (!outputLines.length) {
          settle(() => resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }));
          return;
        }
        const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
        const notices: string[] = [];
        const details: Record<string, unknown> = {};
        if (matchLimitReached) {
          notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
          details.matchLimitReached = limit;
        }
        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          details.truncation = truncation;
        }
        if (linesTruncated) {
          notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
          details.linesTruncated = true;
        }
        const suffix = notices.length ? `\n\n[${notices.join(". ")}]` : "";
        settle(() => resolve({
          content: [{ type: "text", text: truncation.content + suffix }],
          details: Object.keys(details).length ? details : undefined,
        }));
      } catch (error) {
        settle(() => reject(error));
      }
    });
  });
}

export function createWorkspaceSearchToolDefinitions(cwd: string): ToolDefinition[] {
  const ls = createLsToolDefinition(cwd, {
    operations: {
      exists: (path) => access(path).then(() => true, () => false),
      stat,
      // Filter before the native tool sorts, applies its limit, or stats entries.
      readdir: async (path) => (await readdir(path)).filter((entry) => !isReservedDirectory(entry)),
    },
  });
  const find = createFindToolDefinition(cwd, {
    operations: {
      exists: (path) => access(path).then(() => true, () => false),
      glob: guardedGlob,
    },
  });
  const grep = createGrepToolDefinition(cwd);
  return [
    ls,
    find,
    {
      ...grep,
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: { cwd?: string },
      ) => executeGrep(ctx?.cwd ?? cwd, { ...params, path: params.path ?? "." }, signal),
    },
  ] as ToolDefinition[];
}
