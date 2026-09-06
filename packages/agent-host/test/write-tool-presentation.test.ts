import { describe, it, expect } from "vitest";
import { connectorWriteProposal, writeToolPresentation } from "../src/write-tool-presentation.js";

describe("writeToolPresentation", () => {
  it("titles a report export from the document title and lists headings", () => {
    expect(writeToolPresentation("report.export", {
      title: "采购合同审核",
      sections: [{ heading: "摘要" }, { heading: "" }, { heading: "风险" }, { body: "x" }],
    })).toEqual({
      summary: "导出《采购合同审核》",
      preview: { kind: "text", lines: ["摘要", "风险"] },
    });
  });

  it("falls back to 导出报告 when the title is empty", () => {
    expect(writeToolPresentation("report.export", { title: "  " })).toEqual({ summary: "导出报告" });
  });

  it("uses the tool name for other write tools and never stringifies params", () => {
    const out = writeToolPresentation("knowledge.write", { foo: "bar" });
    expect(out).toEqual({ summary: "knowledge.write" });
    expect(out.summary).not.toContain("{");
  });
});

describe("connectorWriteProposal", () => {
  it("keeps the same report.export title for every call site", () => {
    const args = { title: "审核报告", sections: [{ heading: "条款" }] };
    const req = connectorWriteProposal("report.export", args, { requestId: "id1", risk: "write" });
    expect(req.summary).toBe("导出《审核报告》");
    expect(req.summary).not.toContain("{");
    expect(req.preview).toEqual({ kind: "text", lines: ["条款"] });
    expect(req.payload).toBe(args);
  });
});
