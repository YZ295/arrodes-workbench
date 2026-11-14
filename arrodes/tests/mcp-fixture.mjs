import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "arrodes-test-server", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
  name: "audit_total", description: "Return the test refund total.",
  inputSchema: { type: "object", properties: {} },
}] }));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  if (params.name !== "audit_total") throw new Error("Unknown tool");
  if (process.argv[2]) appendFileSync(process.argv[2], "called\n");
  return { content: [{ type: "text", text: "425.76" }] };
});
await server.connect(new StdioServerTransport());
