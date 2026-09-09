import { describe, it, expect } from "vitest";
import {
  commandEnvelope,
  responseEnvelope,
  eventEnvelope,
  proposalEnvelope,
  proposalDecisionEnvelope,
  connectorReadEnvelope,
  connectorReadResultEnvelope,
  readyEnvelope,
} from "../src/pi-runtime-transport.js";

describe("pi runtime transport envelopes", () => {
  it("builds each envelope with the correct direction", () => {
    expect(commandEnvelope("r1", { type: "abort" })).toMatchObject({
      direction: "main-to-runtime",
      id: "r1",
      command: { type: "abort" },
    });
    expect(responseEnvelope("r1", { id: "r1", type: "response", command: "abort", success: true })).toMatchObject({
      direction: "runtime-to-main",
    });
    expect(eventEnvelope({ type: "agent_start" })).toMatchObject({
      direction: "runtime-to-main",
    });
    expect(proposalEnvelope({
      requestId: "p1", toolName: "report.export", targetSystem: "report",
      summary: "export", payload: { path: "a.docx" }, risk: "write",
    })).toMatchObject({ direction: "runtime-to-main", proposal: { requestId: "p1" } });
    expect(proposalDecisionEnvelope("p1", { approved: false, proposalId: "p1", status: "denied" })).toMatchObject({
      direction: "main-to-runtime", requestId: "p1", proposalDecision: { approved: false },
    });
    expect(connectorReadEnvelope({ requestId: "r1", toolName: "knowledge.search", args: { query: "q" } })).toMatchObject({
      direction: "runtime-to-main", connectorRead: { requestId: "r1" },
    });
    expect(connectorReadResultEnvelope("r1", { ok: true, data: { chunks: [] } })).toMatchObject({
      direction: "main-to-runtime", requestId: "r1", connectorReadResult: { ok: true },
    });
    expect(readyEnvelope()).toMatchObject({ direction: "runtime-to-main", ready: true });
  });
});
