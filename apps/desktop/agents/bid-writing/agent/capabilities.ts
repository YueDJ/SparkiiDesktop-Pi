/**
 * Tools the bid-writing agent may use inside its fixed workspace.
 *
 * File writes/deletes go through the generic P1 workspace IPC from the
 * renderer (user edits) and through these Pi tools (agent edits). Both paths
 * are fenced by Workspace Admission and audited; neither creates an Approval
 * Proposal for in-workspace CRUD (2026-10-21 capability-boundary model).
 */
export const bidWritingAgentTools = [
  'read',
  'write',
  'edit',
  'delete',
  'move',
  'knowledge.search',
  'report.export',
];
