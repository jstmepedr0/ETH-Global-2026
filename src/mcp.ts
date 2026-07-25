import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { RULE_ID } from "./domain.js";
import type { VictimFinder } from "./victimFinder.js";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function createServer(victimFinder: VictimFinder): McpServer {
  const server = new McpServer({
    name: "biteback-victim-finder",
    version: "1.0.0",
  });
  server.registerTool(
    "scanViolations",
    {
      title: "Scan deterministic payment violations",
      description:
        "Queries live on-chain transfers through The Graph and clusters wallets charged beyond a signed policy.",
      inputSchema: {
        ruleId: z.string().default(RULE_ID),
        from: z.number().int(),
        to: z.number().int(),
      },
    },
    async ({ ruleId, from, to }) => toolResult(await victimFinder.scanViolations(ruleId, from, to)),
  );
  server.registerTool(
    "findVictims",
    {
      title: "Find incident victims",
      description: "Returns wallets with at least one confirmed excess payment.",
      inputSchema: { incidentId: z.string() },
    },
    async ({ incidentId }) => toolResult(victimFinder.findVictims(incidentId)),
  );
  server.registerTool(
    "calculateLoss",
    {
      title: "Calculate collective loss",
      description: "Recalculates deterministic losses and HBAR compensation server-side.",
      inputSchema: { incidentId: z.string() },
    },
    async ({ incidentId }) => toolResult(victimFinder.calculateLoss(incidentId)),
  );
  server.registerTool(
    "buildEvidencePack",
    {
      title: "Build evidence pack",
      description: "Builds canonical machine-readable evidence and its SHA-256 hash.",
      inputSchema: { incidentId: z.string() },
    },
    async ({ incidentId }) => toolResult(victimFinder.buildEvidencePack(incidentId)),
  );
  return server;
}

export async function handleMcp(
  request: Request,
  victimFinder: VictimFinder,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createServer(victimFinder);
  await server.connect(transport);
  return transport.handleRequest(request);
}
