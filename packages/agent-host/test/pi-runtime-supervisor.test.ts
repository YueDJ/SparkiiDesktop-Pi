import { describe, it, expect, vi } from "vitest";
import {
  PiRuntimeSupervisor,
} from "../src/pi-runtime-supervisor.js";
import {
  responseEnvelope,
  eventEnvelope,
  proposalEnvelope,
  proposalDecisionEnvelope,
  readyEnvelope,
  type PiRuntimeEnvelope,
  type PiRuntimeHostHandle,
} from "../src/pi-runtime-transport.js";

class FakeHandle implements PiRuntimeHostHandle {
  sent: PiRuntimeEnvelope[] = [];
  private messageCb?: (env: PiRuntimeEnvelope) => void;
  private exitCb?: (code: number | null) => void;
  killed = false;

  postMessage(envelope: PiRuntimeEnvelope) { this.sent.push(envelope); }
  onMessage(cb: (env: PiRuntimeEnvelope) => void) { this.messageCb = cb; return () => { this.messageCb = undefined; }; }
  onExit(cb: (code: number | null) => void) { this.exitCb = cb; return () => { this.exitCb = undefined; }; }
  emit(envelope: PiRuntimeEnvelope) { this.messageCb?.(envelope); }
  kill() { this.killed = true; this.exitCb?.(1); }
}

describe("PiRuntimeSupervisor", () => {
  it("starts idempotently and sends commands", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    const a = await sup.start();
    const b = await sup.start();
    expect(a).toBe(b);
    handle.emit(readyEnvelope());
    const p = a.send({ type: "abort" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent = handle.sent[0];
    expect(sent).toMatchObject({ direction: "main-to-runtime", command: { type: "abort" } });
    const id = "id" in sent ? sent.id : "";
    handle.emit(responseEnvelope(id, { id, type: "response", command: "abort", success: true }));
    await expect(p).resolves.toMatchObject({ success: true });
  });

  it("rejects send when no response arrives", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle, { readinessTimeoutMs: 1000, sendTimeoutMs: 100 });
    const client = await sup.start();
    handle.emit(readyEnvelope());
    await expect(client.send({ type: "abort" })).rejects.toThrow(/timed out/);
  });

  it("rejects pending sends when the child exits", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle, { readinessTimeoutMs: 1000, sendTimeoutMs: 5000 });
    const client = await sup.start();
    handle.emit(readyEnvelope());
    const p = client.send({ type: "abort" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    handle.kill();
    await expect(p).rejects.toThrow(/exited/);
  });

  it("streams events and routes proposals", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    const onEvent = vi.fn();
    const onProposal = vi.fn(async () => ({ approved: false, proposalId: "p1", status: "denied" }));
    sup.onProposal(onProposal);
    const client = await sup.start();
    client.onEvent(onEvent);
    handle.emit(eventEnvelope({ type: "agent_start" }));
    expect(onEvent).toHaveBeenCalledWith({ type: "agent_start" });

    const proposal = {
      requestId: "p1", toolName: "report.export", targetSystem: "report",
      summary: "export", payload: { path: "a.docx" }, risk: "write" as const,
    };
    handle.emit(proposalEnvelope(proposal));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onProposal).toHaveBeenCalledWith(proposal);
    expect(handle.sent).toContainEqual(proposalDecisionEnvelope("p1", { approved: false, proposalId: "p1", status: "denied" }));
  });

  it("denies a proposal when the approval handler rejects", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    sup.onProposal(async () => { throw new Error("broker failed"); });
    const client = await sup.start();
    handle.emit(proposalEnvelope({
      requestId: "p2", toolName: "report.export", targetSystem: "report",
      summary: "export", payload: { path: "a.docx" }, risk: "write",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.sent).toContainEqual(proposalDecisionEnvelope("p2", {
      approved: false, proposalId: "p2", status: "denied",
    }));
    expect(client).toBeTruthy();
  });

  it("clears the client and reports exit", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    const onExit = vi.fn();
    sup.onExit(onExit);
    await sup.start();
    handle.emit(readyEnvelope());
    handle.kill();
    expect(onExit).toHaveBeenCalledWith(1);
    expect(handle.killed).toBe(true);
  });
});
