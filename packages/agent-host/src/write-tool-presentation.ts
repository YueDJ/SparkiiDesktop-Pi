import type { ApprovalPreview, ProposalRequest } from "@sparkii/approval";
import type { SideEffect } from "@sparkii/connectors";

export function writeToolPresentation(toolName: string, args: unknown): {
  summary: string;
  preview?: ApprovalPreview;
} {
  if (toolName === "report.export") {
    const rec = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const summary = title ? `导出《${title}》` : "导出报告";
    const sections = Array.isArray(rec.sections) ? rec.sections : [];
    const lines = sections
      .map((section) => (section && typeof section === "object" ? (section as { heading?: unknown }).heading : undefined))
      .filter((heading): heading is string => typeof heading === "string" && heading.trim() !== "");
    return lines.length > 0 ? { summary, preview: { kind: "text", lines } } : { summary };
  }
  return { summary: toolName };
}

export function connectorWriteProposal(
  toolName: string,
  args: unknown,
  extras: { requestId: string; risk: SideEffect },
): ProposalRequest & { requestId: string } {
  const { summary, preview } = writeToolPresentation(toolName, args);
  return {
    requestId: extras.requestId,
    toolName,
    targetSystem: toolName.split(".")[0] ?? toolName,
    summary,
    ...(preview ? { preview } : {}),
    payload: args,
    risk: extras.risk,
  };
}
