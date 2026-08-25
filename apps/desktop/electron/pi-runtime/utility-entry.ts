import {
  createPiSdkSessionHost,
  createPiRuntime,
  type PiRuntimeChildTransport,
  type PiRuntimeEnvelope,
} from "@sparkii/agent-host";

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

const host = await createPiSdkSessionHost({ transport });
createPiRuntime({ host, transport });
