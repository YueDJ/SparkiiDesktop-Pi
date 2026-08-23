import {
  createAgentSession,
  SessionManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";

if (typeof createAgentSession !== "function") {
  throw new Error("createAgentSession is not a function");
}
if (!SessionManager || typeof SessionManager.inMemory !== "function") {
  throw new Error("SessionManager.inMemory is not available");
}
if (typeof defineTool !== "function") {
  throw new Error("defineTool is not a function");
}

console.log("pi sdk api present");
