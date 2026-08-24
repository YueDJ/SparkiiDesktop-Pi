import {
  createPiSdkSessionHost,
  createPiRuntime,
  type PiRuntimeChildTransport,
  type PiRuntimeEnvelope,
} from "@sparkii/agent-host";
import { join } from "node:path";

const transport: PiRuntimeChildTransport = {
  postMessage: (envelope: PiRuntimeEnvelope) => process.send?.(envelope),
  onMessage: (callback) => {
    const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
    process.on("message", listener);
    return () => process.removeListener("message", listener);
  },
};

const skillsDir = process.env.SPARKII_SKILLS_DIR
  ?? (process.env.SPARKII_PROFILE_DIR ? join(process.env.SPARKII_PROFILE_DIR, 'agent', 'skills') : undefined);
const host = await createPiSdkSessionHost({ transport, skillsDir });
createPiRuntime({ host, transport });
