let configured = false;
process.on("message", (env) => {
  if (!env || env.direction !== "main-to-runtime") return;
  const cmd = env.command;
  const respond = (success, data, error) => {
    process.send({
      direction: "runtime-to-main",
      id: env.id,
      response: { id: env.id, type: "response", command: cmd.type, success, data, error },
    });
  };
  if (cmd.type === "configure_session") {
    if (cmd.saddle && cmd.saddle.tools.includes("__unknown__")) {
      respond(false, undefined, "unknown tool: __unknown__");
      return;
    }
    configured = true;
    respond(true);
    return;
  }
  if (cmd.type === "switch_session" && !configured) {
    respond(false, undefined, "switch before configure");
    return;
  }
  if (cmd.type === "get_state") {
    respond(true, { sessionId: "s1", sessionFile: "/tmp/session.json" });
    return;
  }
  respond(true);
});
process.send({ direction: "runtime-to-main", ready: true });
process.stdin.resume();
