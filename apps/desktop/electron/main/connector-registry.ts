import type { ConnectorExecutor } from "@sparkii/approval";
import {
  documentConnector,
  knowledgeConnector,
  reportConnector,
  type Connector,
} from "@sparkii/connectors";

export function registerConnectorHandlers(executor: ConnectorExecutor, toolNames?: Set<string>): void {
  const connectors: Connector[] = [documentConnector, knowledgeConnector, reportConnector];
  for (const connector of connectors) {
    for (const tool of connector.tools) {
      if (!toolNames || toolNames.has(tool.name)) {
        executor.register(tool.name, tool.handler);
      }
    }
  }
}
