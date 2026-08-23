process.on("message", (env) => {
  if (env && env.direction === "main-to-runtime") {
    process.send({
      direction: "runtime-to-main",
      id: env.id,
      response: {
        id: env.id,
        type: "response",
        command: env.command.type,
        success: true,
      },
    });
    process.send({
      direction: "runtime-to-main",
      event: { type: "agent_start" },
    });
  }
});
process.stdin.resume();
