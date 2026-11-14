import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTeamTurn } from "../agent/team.mjs";
import { createMcpToolStore } from "../agent/mcp-tools.mjs";
import { BASIC_AGENT_SKILLS, createTeamSkillStore, selectSkills, skillInstructions } from "../agent/team-skills.mjs";

const config = { baseUrl: "https://fixture.example/v1", modelId: "fixture", apiKey: "fixture" };
const task = {
  id: "audit", role: "execute", title: "核对退款", goal: "生成退款报告",
  requiredInputs: ["orders.csv", "refunds.csv"], requiredAccess: "write", acceptance: "报告列出退款合计及依据",
  dependsOn: [],
};

async function fixture(t, planned, files = []) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "arrodes-preflight-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  for (const file of files) await writeFile(join(workspaceDir, file), "sample");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(planned) } }] }),
  }));
  const events = [];
  return {
    workspaceDir, events, fetchMock,
    run: (options = {}) => runTeamTurn({
      text: "核对工作区的订单和退款并生成报告", history: [], workspaceDir, config,
      onCanvasEvent: (event) => events.push(event),
      ...options,
    }),
  };
}

test("缺输入时先说明缺什么，不派发或写入", async (t) => {
  const fx = await fixture(t, { action: "run", tasks: [task] }, ["orders.csv"]);
  await mkdir(join(fx.workspaceDir, "refunds.csv"));
  const result = await fx.run();
  assert.equal(result.kind, "reply");
  assert.match(result.text, /缺少.*refunds\.csv/);
  assert.doesNotMatch(result.text, /orders\.csv/);
  assert.deepEqual(fx.events, []);
  assert.deepEqual((await readdir(fx.workspaceDir)).sort(), ["orders.csv", "refunds.csv"]);
  assert.equal(fx.fetchMock.mock.callCount(), 1);
});

test("有文件时也不能把写任务交给只读角色", async (t) => {
  const fx = await fixture(t, { action: "run", tasks: [{ ...task, role: "research" }] }, task.requiredInputs);
  const result = await fx.run();
  assert.equal(result.kind, "reply");
  assert.match(result.text, /调研 Agent.*只读/);
  assert.deepEqual(fx.events, []);
  assert.equal(fx.fetchMock.mock.callCount(), 1);
});

test("越界路径在读取前被拒绝", async (t) => {
  const fx = await fixture(t, { action: "run", tasks: [{ ...task, requiredInputs: ["../private.csv"] }] });
  const result = await fx.run();
  assert.equal(result.kind, "error");
  assert.match(result.text, /工作区内/);
  assert.deepEqual(fx.events, []);
  assert.equal(fx.fetchMock.mock.callCount(), 1);
});

test("协调者默认收到团队协调 Skill 和文件清单", async (t) => {
  const fx = await fixture(t, { action: "reply", text: "请补充退款记录。" }, ["orders.csv"]);
  assert.equal((await fx.run()).kind, "reply");
  const { messages } = JSON.parse(fx.fetchMock.mock.calls[0].arguments[1].body);
  assert.match(messages[0].content, /Skill：团队协调/);
  assert.deepEqual(JSON.parse(messages[1].content).workspaceEntries, ["orders.csv"]);
  assert.deepEqual(fx.events, []);
});

test("后续任务可以依赖本次将生成的文件", async (t) => {
  const planned = { action: "run", tasks: [
    { ...task, outputs: ["report.md"] },
    { ...task, id: "review-input", role: "research", requiredAccess: "read",
      requiredInputs: ["report.md"], dependsOn: ["audit"], outputs: [] },
  ] };
  const fx = await fixture(t, planned, task.requiredInputs);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const stage = JSON.parse(options.body).messages[0].content.split("\n")[0];
    let content = "完成了当前检查。";
    if (stage === "协作阶段：规划") content = JSON.stringify(planned);
    if (stage === "协作阶段：验收") content = JSON.stringify({ passed: false, reason: "夹具未写入文件" });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  const result = await fx.run();
  assert.equal(result.kind, "reply");
  assert.equal(result.collaboration?.passed, false);
  assert.ok(fx.events.some((event) => event.type === "plan"));
  assert.ok(fx.fetchMock.mock.callCount() > 1);
});

test("普通对话展示技能目录，按当前目标加载正文", () => {
  const context = (text) => skillInstructions(BASIC_AGENT_SKILLS, selectSkills(BASIC_AGENT_SKILLS, text));
  assert.match(context("你好"), /表格与数据分析/);
  assert.doesNotMatch(context("你好"), /### Skill/);
  assert.match(context("统计 CSV 的退款合计"), /### Skill：表格与数据分析/);
  assert.doesNotMatch(context("统计 CSV 的退款合计"), /### Skill：项目开发/);
});

test("协作仅加载分给角色的相关内置 Skill 并保留自定义正文", async (t) => {
  const role = {
    id: "auditor", name: "审计员", description: "负责退款核对", access: "write",
    skillIds: ["builtin-code", "builtin-data", "local-rules"],
  };
  const custom = { id: "local-rules", name: "审计口径", description: "", instructions: "仅统计已完成退款。" };
  const planned = { action: "run", tasks: [{ ...task, role: role.id }] };
  const fx = await fixture(t, planned, task.requiredInputs);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const [{ content: system }] = JSON.parse(options.body).messages;
    const content = system.startsWith("协作阶段：规划") ? JSON.stringify(planned)
      : system.startsWith("协作阶段：验收") ? JSON.stringify({ passed: true, reason: "已核对" })
      : "已完成。";
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  const result = await fx.run({ customRoles: [role], skills: [...BASIC_AGENT_SKILLS, custom] });
  assert.equal(result.collaboration?.passed, true);
  const workerPrompt = fx.fetchMock.mock.calls
    .map(({ arguments: [, options] }) => JSON.parse(options.body).messages[0].content)
    .find((system) => system.includes("角色：审计员"));
  assert.match(workerPrompt, /项目开发/);
  assert.doesNotMatch(workerPrompt, /### Skill：项目开发|### Skill：网页调研与桌面操作/);
  assert.match(workerPrompt, /### Skill：表格与数据分析/);
  assert.match(workerPrompt, /仅统计已完成退款/);
  assert.deepEqual(fx.events.find(({ type, taskId }) => type === "skill.applied" && taskId === "audit")?.skills,
    ["表格与数据分析", "审计口径"]);
});

test("导入的适用场景持久化，命中后只加载相关 Skill，旧 Skill 与无命中回退可用", async (t) => {
  const fx = await fixture(t, {});
  const store = createTeamSkillStore(fx.workspaceDir);
  const refund = Buffer.from("退款专用流程。");
  const refundId = store.importMarkdown(refund, "refund.md");
  const gitId = store.importMarkdown(Buffer.from("提交说明。"), "git.md", "提交规范，Git 提交");
  assert.equal(store.importMarkdown(refund, "refund.md", "退款审计，ＲＥＦＵＮＤ"), refundId);
  const oldId = store.importMarkdown(Buffer.from("旧版无场景。"), "legacy.md");
  const skills = createTeamSkillStore(fx.workspaceDir).list().filter(({ id }) => [refundId, gitId, oldId].includes(id));
  const names = (text) => selectSkills(skills, text, { fallback: true }).map(({ name }) => name);
  assert.deepEqual(names("执行 Refund 审计"), ["refund", "legacy"]);
  assert.deepEqual(names("做一项通用检查"), ["refund", "git", "legacy"]);
  const data = BASIC_AGENT_SKILLS.find(({ id }) => id === "builtin-data");
  assert.deepEqual(selectSkills([data, ...skills], "核对 CSV 文件", { fallback: true }).map(({ name }) => name),
    [data.name, "refund", "git", "legacy"]);
});

test("真实 stdio MCP 仅由获授权角色调用，拒绝批准和越权均不会执行", async (t) => {
  const planned = { action: "run", tasks: [
    { ...task, id: "allowed", requiredInputs: [] },
    { ...task, id: "denied", role: "research", requiredAccess: "read", requiredInputs: [], dependsOn: ["allowed"] },
  ] };
  const fx = await fixture(t, planned);
  const callLog = join(fx.workspaceDir, "mcp-calls.txt");
  const store = createMcpToolStore(join(fx.workspaceDir, "settings"));
  const [server] = await store.connect({ name: "退款服务", command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url)), callLog] }, () => {});
  const [{ id }] = server.tools;
  store.setGrants("execute", [id]);
  const restored = createMcpToolStore(join(fx.workspaceDir, "settings"));
  let attempted = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages, tools = [] } = JSON.parse(options.body);
    const system = messages[0].content;
    let message = { content: "完成" };
    if (system.startsWith("协作阶段：规划")) message.content = JSON.stringify(planned);
    else if (system.startsWith("协作阶段：验收")) message.content = JSON.stringify({ passed: true, reason: "已验证" });
    else if (system.startsWith("协作阶段：执行") || system.startsWith("协作阶段：调研")) {
      const authorized = system.startsWith("协作阶段：执行");
      assert.equal(tools.some(({ function: tool }) => tool.name === id), authorized);
      const results = messages.filter(({ role }) => role === "tool").map(({ content }) => JSON.parse(content));
      if (results.length < (authorized ? 2 : 1)) {
        message = { tool_calls: [{ id: `call-${results.length}`, type: "function", function: { name: id, arguments: "{}" } }] };
      } else if (authorized) {
        assert.equal(results[0].cancelled, true);
        assert.deepEqual(results[1], { ok: true, output: "425.76" });
      } else {
        assert.equal(results[0].ok, false);
        assert.match(results[0].output, /不可用/);
      }
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run({ mcpForRole: (id) => restored.forRole(id), approveAction: () => ++attempted === 2 });
  assert.equal(result.collaboration?.passed, true);
  assert.equal(attempted, 2);
  assert.equal(await readFile(callLog, "utf8"), "called\n");
  const trace = fx.events.filter(({ type }) => type === "mcp.result");
  assert.deepEqual(trace.map(({ taskId, ok, cancelled }) => ({ taskId, ok, cancelled })), [
    { taskId: "allowed", ok: false, cancelled: true },
    { taskId: "allowed", ok: true, cancelled: false },
  ]);
  assert.equal(trace[1].output, "425.76");
  assert.deepEqual(restored.remove(server.id), []);
  assert.deepEqual(restored.grants("execute"), []);
});
