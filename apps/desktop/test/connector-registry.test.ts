import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ConnectorExecutor, AuditStore, createProposal } from "@sparkii/approval";
import { reportConnector } from "@sparkii/connectors";
import { registerConnectorHandlers } from "../electron/main/connector-registry.js";

describe("connector registry", () => {
  it("registers report.export so an approved write executes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sparkii-registry-"));
    const outPath = join(dir, "report.docx");
    const audit = new AuditStore(join(dir, "audit.db"));
    const executor = new ConnectorExecutor(audit);
    registerConnectorHandlers(executor);

    const proposal = createProposal({
      toolName: "report.export",
      targetSystem: "report",
      summary: "export",
      payload: { title: "x", sections: [{ heading: "h", body: "b" }], format: "docx", path: outPath },
      risk: "write",
    }, { profileId: "p", sessionId: "s" });

    const executed = await executor.execute({ ...proposal, status: "approved" }, { actor: "admin" });
    expect(executed.status).toBe("executed");
    expect(executed.execution?.ok).toBe(true);
    expect(reportConnector.tools.length).toBeGreaterThan(0);
    audit.close();
  });
});
