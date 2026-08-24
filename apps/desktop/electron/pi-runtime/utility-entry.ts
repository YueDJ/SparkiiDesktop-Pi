import {
  createPiSdkSessionHost,
  createPiRuntime,
  type PiRuntimeChildTransport,
  type PiRuntimeEnvelope,
} from "@sparkii/agent-host";
import { join } from "node:path";

const childPort = process.parentPort;

const transport: PiRuntimeChildTransport = {
  postMessage: (envelope: PiRuntimeEnvelope) => childPort.postMessage(envelope),
  onMessage: (callback) => {
    const listener = (messageEvent: Electron.MessageEvent) =>
      callback(messageEvent.data as PiRuntimeEnvelope);
    childPort.on("message", listener);
    return () => childPort.removeListener("message", listener);
  },
};

const skillsDir = process.env.SPARKII_SKILLS_DIR
  ?? (process.env.SPARKII_PROFILE_DIR ? join(process.env.SPARKII_PROFILE_DIR, 'agent', 'skills') : undefined);
const host = await createPiSdkSessionHost({ transport, skillsDir });
createPiRuntime({ host, transport });
