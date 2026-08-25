import {
  createPiSdkSessionHost,
  createPiRuntime,
  type PiRuntimeChildTransport,
  type PiRuntimeEnvelope,
} from "@sparkii/agent-host";

const transport: PiRuntimeChildTransport = {
  postMessage: (envelope: PiRuntimeEnvelope) => process.send?.(envelope),
  onMessage: (callback) => {
    const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
    process.on("message", listener);
    return () => process.removeListener("message", listener);
  },
};

const host = await createPiSdkSessionHost({ transport });
createPiRuntime({ host, transport });
