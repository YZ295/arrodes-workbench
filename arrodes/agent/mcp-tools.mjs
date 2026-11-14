import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const timeout = { timeout: 15_000 };
const key = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function readConnection(input) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  const args = input?.args;
  if (!name || name.length > 60 || !command || command.length > 1024 || /[\x00-\x1f]/.test(name + command) ||
      !Array.isArray(args) || args.length > 32 ||
      args.some((arg) => typeof arg !== "string" || arg.length > 2048 || arg.includes("\0"))) {
    throw new Error("请输入服务器名称、可执行程序及 JSON 字符串参数数组。");
  }
  return { id: key([command, args]), name, command, args };
}

async function withServer(connection, operation) {
  const client = new Client({ name: "arrodes", version: "1.1.0" });
  const transport = new StdioClientTransport({
    command: connection.command, args: connection.args, stderr: "pipe",
  });
  transport.stderr?.resume();
  try {
    await client.connect(transport, timeout);
    if (!client.getServerCapabilities()?.tools) throw new Error("服务器没有提供工具。");
    return await operation(client);
  } finally {
    await client.close();
  }
}

async function discover(client) {
  const tools = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, timeout);
    if (tools.length + page.tools.length > 100 || seen.has(page.nextCursor)) {
      throw new Error("MCP 工具列表过大或分页异常。");
    }
    for (const { name, description, inputSchema } of page.tools) {
      if (!name || name.length > 128 || JSON.stringify(inputSchema).length > 12_000) continue;
      if (tools.some((tool) => tool.name === name)) throw new Error("MCP 返回了同名工具。");
      tools.push({ name, description: description?.slice(0, 1000) ?? "", inputSchema });
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) seen.add(cursor);
    if (seen.size > 10) throw new Error("MCP 工具列表分页过多。");
  } while (cursor !== undefined);
  return tools;
}

export function createMcpToolStore(dataDir) {
  const file = join(dataDir, "mcp-tools.json");
  function load() {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { servers: [], grants: {} };
    }
  }
  function save(state) {
    mkdirSync(dataDir, { recursive: true });
    const pending = `${file}.${randomUUID()}.tmp`;
    writeFileSync(pending, JSON.stringify(state, null, 2), "utf8");
    renameSync(pending, file);
  }
  function pruneGrants(state) {
    const known = new Set(catalog(state).flatMap(({ tools }) => tools.map(({ id }) => id)));
    for (const roleId of Object.keys(state.grants)) {
      state.grants[roleId] = state.grants[roleId].filter((id) => known.has(id));
    }
  }
  const toolId = (server, tool) => `mcp_${key([server.id, tool.name, tool.inputSchema]).slice(0, 32)}`;
  const catalog = (state) => state.servers.map((server) => ({
    id: server.id, name: server.name,
    tools: server.tools.map((tool) => ({ id: toolId(server, tool), name: tool.name, description: tool.description })),
  }));
  return {
    list: () => catalog(load()),
    grants: (roleId) => load().grants[roleId] ?? [],
    async connect(input, ensureIdle) {
      const connection = readConnection(input);
      const tools = await withServer(connection, discover);
      ensureIdle();
      const state = load();
      state.servers = [...state.servers.filter(({ id }) => id !== connection.id), { ...connection, tools }];
      pruneGrants(state);
      save(state);
      return catalog(state);
    },
    remove(serverId) {
      const state = load();
      state.servers = state.servers.filter(({ id }) => id !== serverId);
      pruneGrants(state);
      save(state);
      return catalog(state);
    },
    setGrants(roleId, ids) {
      const state = load();
      const known = new Set(catalog(state).flatMap(({ tools }) => tools.map(({ id }) => id)));
      if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
        throw new Error("请为角色选择最多 20 个当前可用的 MCP 工具。");
      }
      state.grants[roleId] = ids;
      save(state);
    },
    forRole(roleId) {
      const state = load();
      const allowed = new Set(state.grants[roleId] ?? []);
      return state.servers.flatMap((server) => server.tools.flatMap((tool) => {
        const name = toolId(server, tool);
        if (!allowed.has(name)) return [];
        const label = `${server.name} / ${tool.name}`;
        return [{
          label,
          definition: { type: "function", function: { name, description: `${label}：${tool.description}`, parameters: tool.inputSchema } },
          async call(args) {
            return withServer(server, async (client) => {
              const current = (await discover(client)).find((item) => item.name === tool.name);
              if (!current || toolId(server, current) !== name) {
                throw new Error("MCP 工具已变更，请重新测试连接并授权。");
              }
              const result = await client.callTool({ name: tool.name, arguments: args }, undefined, timeout);
              const output = result.structuredContent ?? result.content?.filter(({ type }) => type === "text").map(({ text }) => text).join("\n") ?? "";
              return { ok: result.isError !== true, output: (typeof output === "string" ? output : JSON.stringify(output)).slice(0, 3500) };
            });
          },
        }];
      }));
    },
  };
}
