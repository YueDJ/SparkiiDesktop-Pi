import { join } from "node:path";
import {
  createAgentSessionServices,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

let pendingSaddle = null;
let lastSkillNames = [];
let modelRuntime;

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
  throw new Error("PI_CODING_AGENT_DIR is required");
}

async function bindSkills() {
  modelRuntime ??= await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const services = await createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: {
      additionalSkillPaths: pendingSaddle?.skillsDir ? [pendingSaddle.skillsDir] : [],
    },
  });
  lastSkillNames = services.resourceLoader.getSkills().skills.map((skill) => skill.name);
}

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

  void (async () => {
    try {
      if (cmd.type === "configure_session") {
        pendingSaddle = cmd.saddle;
        respond(true);
        return;
      }
      if (cmd.type === "new_session" || cmd.type === "switch_session") {
        await bindSkills();
        respond(true, { skills: lastSkillNames });
        return;
      }
      if (cmd.type === "get_state") {
        respond(true, { skills: lastSkillNames, sessionId: "s1" });
        return;
      }
      respond(true);
    } catch (error) {
      respond(false, undefined, error instanceof Error ? error.message : String(error));
    }
  })();
});

process.send({ direction: "runtime-to-main", ready: true });
process.stdin.resume();
