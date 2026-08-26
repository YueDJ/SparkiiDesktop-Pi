import { readFileSync } from "node:fs";
import {
  parseSessionEntries,
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

export interface PiSessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  created: Date;
  modified: Date;
  messageCount: number;
}

export async function listPiSessions(sessionDir: string): Promise<PiSessionSummary[]> {
  const sessions: SessionInfo[] = await SessionManager.listAll(sessionDir);
  return sessions.map((session) => ({
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    firstMessage: session.firstMessage,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
  }));
}

export function readPiSessionMessages(filePath: string): Array<{ role: string; content: unknown }> {
  const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
  return entries
    .filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
    .map((entry) => entry.message as { role: string; content: unknown });
}
