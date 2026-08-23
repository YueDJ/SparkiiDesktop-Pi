import { utilityProcess, type UtilityProcess } from "electron";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import type { PiRuntimeEnvelope, PiRuntimeHostHandle } from "@sparkii/agent-host";

export function createUtilityHostHandle(entryPath: string): PiRuntimeHostHandle {
  const child: UtilityProcess = utilityProcess.fork(entryPath, [], {
    serviceName: "sparkii-pi-runtime",
  });
  return {
    postMessage: (envelope) => child.postMessage(envelope),
    onMessage: (callback) => {
      const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
      child.on("message", listener);
      return () => child.removeListener("message", listener);
    },
    onExit: (callback) => {
      const listener = (code: number) => callback(code);
      child.on("exit", listener);
      return () => child.removeListener("exit", listener);
    },
    kill: () => child.kill(),
  };
}

export function createForkHostHandle(entryPath: string): PiRuntimeHostHandle {
  const child: ChildProcess = fork(entryPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
  } as ForkOptions);
  return {
    postMessage: (envelope) => child.send(envelope),
    onMessage: (callback) => {
      const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
      child.on("message", listener);
      return () => child.removeListener("message", listener);
    },
    onExit: (callback) => {
      const listener = (code: number | null) => callback(code);
      child.on("exit", listener);
      return () => child.removeListener("exit", listener);
    },
    kill: () => child.kill(),
  };
}
