import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTeamTurn } from "../agent/team.mjs";
import { runAgentTurn } from "../agent/loop.mjs";
import { pendingClarification, resolveClarification } from "../agent/clarification.mjs";
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
  assert.match(result.text, /文件检查失败：report\.md/);
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

test("用户选定落盘方案后，普通对话自动重试重复的选项并写出文件", async (t) => {
  const path = "交叉分析.md";
  const prompt = "请选择一个方向：1. 只读盘点；2. 交叉分析并落盘。";
  const history = [{ role: "user", content: "深度学习当前文件夹" }, { role: "assistant", content: prompt }];
  const fx = await fixture(t, {}, ["orders.csv", "refunds.csv"]);
  let requests = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    assert.equal(messages[3].content, "交叉分析并落盘");
    let message = { content: prompt };
    if (++requests > 1) {
      assert.match(messages[0].content, /结合上一轮给出的选项/);
      message = messages.some(({ role }) => role === "tool")
        ? { content: "已写出交叉分析报告。" }
        : { tool_calls: [{ id: "write", type: "function", function: {
          name: "write_file", arguments: JSON.stringify({ path, content: "分析结果" }),
        } }] };
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await runAgentTurn({ text: "交叉分析并落盘", history, workspaceDir: fx.workspaceDir, config });
  assert.equal(result.text, "已写出交叉分析报告。");
  assert.equal(await readFile(join(fx.workspaceDir, path), "utf8"), "分析结果");
});

test("协调者重复选项时只尝试纠正一次", async (t) => {
  const prompt = "请选择一个方向：只读或者写报告。";
  const fx = await fixture(t, { action: "reply", text: prompt });
  const result = await fx.run({ text: "写报告", history: [
    { role: "user", content: "分析文件" }, { role: "assistant", content: prompt },
  ] });
  assert.equal(fx.fetchMock.mock.callCount(), 2);
  assert.equal(result.kind, "error");
  assert.deepEqual(fx.events, []);
});

test("协调者返回待确认任务，可用编号选择并保留交付路径", async (t) => {
  const fx = await fixture(t, { action: "clarify", question: "如何交付？", options: [
    { label: "只汇报", task: "汇总数据", inputs: ["orders.csv"], outputs: [] },
    { label: "写报告", task: "交叉分析", inputs: ["orders.csv", "refunds.csv"], outputs: ["报告.md"] },
  ] });
  const result = await fx.run();
  assert.equal(result.kind, "clarify");
  assert.deepEqual(fx.events, []);
  const pending = pendingClarification(result.clarification, "team", "分析当前数据");
  const confirmed = resolveClarification(pending, "选 2");
  assert.equal(confirmed.mode, "team");
  assert.match(confirmed.text, /已选方案：写报告[\s\S]*"orders\.csv","refunds\.csv"[\s\S]*"报告\.md"/);
  assert.deepEqual(resolveClarification(pending, "取消"), { cancelled: true });
  assert.equal(resolveClarification(pending, "你好"), null);
  assert.equal(resolveClarification(pending, "工作区在哪里"), null);
  assert.match(resolveClarification(pending, "补充：只看七月").text, /用户补充：只看七月/);
  assert.throws(() => resolveClarification(pending, "写报告", { id: "stale", index: 1 }), /已失效/);
});

test("写报告参数可补正，验收 Agent 只能读取本轮产物", async (t) => {
  const path = "订单分析.md";
  const planned = { action: "run", tasks: [{ ...task, requiredInputs: [], outputs: [path] }] };
  const fx = await fixture(t, planned, ["private.txt"]);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages, tools } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message = { content: "已完成。" };
    if (stage === "协作阶段：规划") message.content = JSON.stringify(planned);
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      if (results.length === 1) assert.match(JSON.parse(results[0].content).output, /不.*完整.*JSON/);
      if (results.length < 2) {
        message = { tool_calls: [{ id: `write-${results.length}`, type: "function", function: {
          name: "write_file", arguments: results.length ? JSON.stringify({ path, content: "订单统计" }) : '{"content":',
        } }] };
      }
    }
    if (stage === "协作阶段：验收") {
      assert.ok(JSON.parse(messages[1].content).checks.some((check) => check.path === path && check.ok));
      assert.deepEqual(new Set(tools.map((tool) => tool.function.name)), new Set(["verify_file", "read_file", "read_table", "read_document"]));
      const results = messages.filter(({ role }) => role === "tool").map(({ content }) => JSON.parse(content));
      if (!results.length) {
        message = { tool_calls: [path, "private.txt"].map((target, index) => ({
          id: `review-${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: target }) },
        })) };
      } else {
        assert.deepEqual(results[0], { ok: true, output: "订单统计" });
        assert.equal(results[1].ok, false);
        assert.match(results[1].output, /仅可访问/);
        message.content = JSON.stringify({ passed: true, reason: "报告可读。" });
      }
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  assert.equal((await fx.run()).collaboration?.passed, true);
  assert.equal(await readFile(join(fx.workspaceDir, path), "utf8"), "订单统计");
});

test("协作最后一轮工具结果可收尾且收尾没有工具权限", async (t) => {
  const fx = await fixture(t, {}, ["orders.csv"]);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages, tools } = JSON.parse(options.body);
    let message;
    if (tools) {
      message = { tool_calls: [{ id: "tools-1", type: "function", function: { name: "list_dir", arguments: "{}" } }] };
    } else {
      assert.match(messages.find(({ role }) => role === "tool").content, /orders\.csv/);
      message = { content: "已找到订单源文件。" };
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await runAgentTurn({ text: "检查工作区", history: [], workspaceDir: fx.workspaceDir, config,
    collaboration: { stage: "调研", instructions: "", tools: ["list_dir"], maxRounds: 1 } });
  assert.deepEqual(result, { kind: "reply", text: "已找到订单源文件。" });
  assert.equal(fx.fetchMock.mock.callCount(), 2);
});

test("画布连线在上游未参与时自动忽略，不阻塞无关任务（条件语义）", async (t) => {
  const web = { id: "web", name: "网页调研", description: "搜索网页", access: "read" };
  const deliver = { ...task, id: "deliver", requiredInputs: [] };
  const fx = await fixture(t, {});
  let plans = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let content = "完成。";
    if (stage === "协作阶段：规划") {
      plans++;
      const input = JSON.parse(messages[1].content);
      assert.deepEqual(input.handoffs, [{ from: web.id, to: "execute" }]);
      content = JSON.stringify({ action: "run", tasks: [deliver] }); // 不给网页调研派任务
    }
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) content = JSON.stringify({ tool_calls: [{ id: "w1", type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "report.md", content: "已完成交付" }) } }] });
    }
    if (stage === "协作阶段：验收") content = JSON.stringify({ passed: true, reason: "已验收。" });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  const canvas = { configured: true, nodes: ["coordinator", "reviewer", "execute", web.id].map((id) => ({ id, x: 0, y: 0 })),
    edges: [{ from: web.id, to: "execute" }] };
  const result = await fx.run({ canvas, customRoles: [web] });
  assert.equal(result.collaboration?.passed, true);
  assert.equal(plans, 1); // 无需纠正：连线不强制无关角色参与
  const planEvent = fx.events.find(({ type }) => type === "plan");
  assert.deepEqual(planEvent.tasks.find(({ taskId }) => taskId === "deliver").dependsOn, []);
});

test("画布连线在两端角色都参与时生效为交接依赖", async (t) => {
  const web = { id: "web", name: "网页调研", description: "搜索网页", access: "read" };
  const research = { ...task, id: "web-search", role: web.id, requiredInputs: [], requiredAccess: "read" };
  const deliver = { ...task, id: "deliver", requiredInputs: [] };
  const fx = await fixture(t, {});
  let plans = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let content = "完成。";
    if (stage === "协作阶段：规划") {
      plans++;
      content = JSON.stringify({ action: "run", tasks: [research, deliver] }); // 两个角色都参与分工
    }
    if (stage === "协作阶段：验收") content = JSON.stringify({ passed: true, reason: "已验收。" });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  const canvas = { configured: true, nodes: ["coordinator", "reviewer", "execute", web.id].map((id) => ({ id, x: 0, y: 0 })),
    edges: [{ from: web.id, to: "execute" }] };
  const result = await fx.run({ canvas, customRoles: [web] });
  assert.equal(result.collaboration?.passed, true);
  assert.equal(plans, 1);
  const planEvent = fx.events.find(({ type }) => type === "plan");
  assert.deepEqual(planEvent.tasks.find(({ taskId }) => taskId === "deliver").dependsOn, ["web-search"]); // 连线生效为交接依赖
});

test("只读角色误派写任务时自动纠正一次，两轮仍失败给出指引", async (t) => {
  const web = { id: "web", name: "网页调研", description: "搜索网页", access: "read" };
  const research = { ...task, id: "web-search", role: web.id, requiredInputs: [], requiredAccess: "read" };
  const deliver = { ...task, id: "deliver", requiredInputs: [] };
  const fx = await fixture(t, {});
  let plans = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let content = "完成。";
    if (stage === "协作阶段：规划") {
      const request = JSON.parse(messages[1].content);
      if (++plans === 2) assert.match(request.correction, /网页调研/);
      // 始终把写任务派给只读角色
      content = JSON.stringify({ action: "run", tasks: [{ ...research, requiredAccess: "write" }, deliver] });
    }
    if (stage === "协作阶段：验收") content = JSON.stringify({ passed: true, reason: "已验收。" });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  const canvas = { configured: true, nodes: ["coordinator", "reviewer", "execute", web.id].map((id) => ({ id, x: 0, y: 0 })),
    edges: [{ from: web.id, to: "execute" }] };
  const result = await fx.run({ canvas, customRoles: [web] });
  assert.equal(result.kind, "reply");
  assert.match(result.text, /连续两轮都无法自动修复/);
  assert.match(result.text, /只有读取权限/);
  assert.match(result.text, /写权限的角色/);
  assert.equal(plans, 2); // 首次规划 + 1 轮权限纠正
  assert.deepEqual(fx.events, []);
});

test("协作导出同名 XLSX 时保留原文件并报告失败原因", async (t) => {
  const path = "订单明细.xlsx";
  const planned = { action: "run", tasks: [{ ...task, requiredInputs: [], outputs: [path] }] };
  const fx = await fixture(t, planned, [path]);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message;
    if (stage === "协作阶段：规划") message = { content: JSON.stringify(planned) };
    else {
      assert.equal(stage, "协作阶段：执行");
      message = messages.some(({ role }) => role === "tool")
        ? { content: "无法写入。" }
        : { tool_calls: [{ id: "export", type: "function", function: {
          name: "export_xlsx", arguments: JSON.stringify({ path, rows: [["订单号"], ["001"]] }),
        } }] };
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run();
  assert.equal(result.collaboration?.passed, false);
  assert.match(result.text, /核对退款失败.*export_xlsx.*目标 XLSX 已存在/);
  assert.equal(await readFile(join(fx.workspaceDir, path), "utf8"), "sample");
});

for (const exportAfterReminder of [false, true]) {
  test(`XLSX 交付门禁：${exportAfterReminder ? "补导出后进入验收" : "口头完成无法进入验收"}`, async (t) => {
    const path = "订单明细-验证.xlsx";
    const planned = { action: "run", tasks: [{ ...task, requiredInputs: [], outputs: [path] }] };
    const fx = await fixture(t, planned);
    let reviews = 0;
    fx.fetchMock.mock.mockImplementation(async (_url, options) => {
      const { messages, tools = [] } = JSON.parse(options.body);
      const stage = messages[0].content.split("\n")[0];
      let message = { content: "已完成。" };
      if (stage === "协作阶段：规划") message.content = JSON.stringify(planned);
      if (stage === "协作阶段：执行") {
        assert.ok(tools.some((tool) => tool.function.name === "export_xlsx"));
        assert.ok(!tools.some((tool) => tool.function.name === "run_powershell"));
        const reminded = messages.some(({ content }) => content?.includes("尚未生成："));
        if (exportAfterReminder && reminded && !messages.some(({ role }) => role === "tool")) {
          message = { tool_calls: [{ id: "export", type: "function", function: {
            name: "export_xlsx", arguments: JSON.stringify({ path, rows: [["订单号", "金额"], ["001", 42]] }),
          } }] };
        }
      }
      if (stage === "协作阶段：验收") {
        reviews++;
        const { checks } = JSON.parse(messages[1].content);
        assert.equal(checks[0].path, path);
        assert.equal(checks[0].ok, true);
        message.content = JSON.stringify({ passed: true, reason: "文件已重新打开。" });
      }
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    });
    const result = await fx.run({ approveAction: async () => true });
    assert.equal(result.collaboration?.passed, exportAfterReminder);
    assert.equal(reviews, Number(exportAfterReminder));
    if (!exportAfterReminder) assert.match(result.text, /尚未生成：订单明细-验证.xlsx/);
  });
}

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

test("验收未通过时协调者反思并重规划一次（自我循环）", async (t) => {
  const planned = { action: "run", tasks: [{ ...task, requiredInputs: [], outputs: ["report.md"] }] };
  const fx = await fixture(t, planned, []);
  let planCalls = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message = { content: "已完成。" };
    if (stage === "协作阶段：规划") {
      planCalls++;
      const input = JSON.parse(messages[1].content);
      if (planCalls === 1) message.content = JSON.stringify(planned);
      else {
        assert.match(input.correction ?? "", /未通过|失败/);
        message.content = JSON.stringify(planned);
      }
    }
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) message = { tool_calls: [{ id: `w-${planCalls}`, type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "report.md", content: planCalls === 1 ? "草稿，缺合计" : "最终报告：合计 425.76" }) } }] };
    }
    if (stage === "协作阶段：验收") {
      message.content = JSON.stringify(planCalls === 1
        ? { passed: false, reason: "报告缺少退款合计。" }
        : { passed: true, reason: "报告包含合计。" });
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run();
  assert.equal(result.kind, "reply");
  assert.equal(result.collaboration?.passed, true);
  const iterations = result.collaboration.canvasEvents.filter(({ type }) => type === "selfloop.iteration");
  assert.equal(iterations.length, 1);
  assert.match(iterations[0].reason, /合计/);
  assert.equal(planCalls, 2);
  assert.equal(await readFile(join(fx.workspaceDir, "report.md"), "utf8"), "最终报告：合计 425.76");
});

test("自我循环上限：两轮都失败时如实报告，不无限重试", async (t) => {
  const planned = { action: "run", tasks: [{ ...task, requiredInputs: [], outputs: ["report.md"] }] };
  const fx = await fixture(t, planned, []);
  let planCalls = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message = { content: "已完成。" };
    if (stage === "协作阶段：规划") {
      planCalls++;
      message.content = JSON.stringify(planned);
    }
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) message = { tool_calls: [{ id: `w-${planCalls}`, type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "report.md", content: "仍然不完整" }) } }] };
    }
    if (stage === "协作阶段：验收") {
      message.content = JSON.stringify({ passed: false, reason: "报告始终缺少合计。" });
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run();
  assert.equal(result.kind, "reply");
  assert.equal(result.collaboration?.passed, false);
  assert.match(result.text, /未通过验收/);
  const iterations = result.collaboration.canvasEvents.filter(({ type }) => type === "selfloop.iteration");
  assert.equal(iterations.length, 1);
  assert.equal(planCalls, 2);
  assert.equal((await readdir(fx.workspaceDir)).includes("report.md"), true); // 写任务真实落盘，但验收未通过
});

test("规划可以创建临时角色并在本轮内执行其任务", async (t) => {
  const planned = { action: "run",
    subAgents: [{ name: "数据清洗员", description: "清洗退款数据并生成报告。", access: "write" }],
    tasks: [{ ...task, role: "sub-1", requiredInputs: [], outputs: ["report.md"] }] };
  const fx = await fixture(t, planned, ["orders.csv"]);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message = { content: "已完成。" };
    if (stage === "协作阶段：规划") {
      const input = JSON.parse(messages[1].content);
      assert.ok(!input.roles.some(({ id }) => String(id).startsWith("sub-")));
      message.content = JSON.stringify(planned);
    }
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      assert.match(messages[0].content, /角色：数据清洗员/);
      if (!results.length) message = { tool_calls: [{ id: "w1", type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "report.md", content: "已清洗并生成报告" }) } }] };
    }
    if (stage === "协作阶段：验收") message.content = JSON.stringify({ passed: true, reason: "报告可读。" });
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run();
  assert.equal(result.collaboration?.passed, true);
  const created = result.collaboration.canvasEvents.filter(({ type }) => type === "subagent.created");
  assert.equal(created.length, 1);
  assert.equal(created[0].roleName, "数据清洗员");
  assert.equal(created[0].access, "write");
  assert.equal(await readFile(join(fx.workspaceDir, "report.md"), "utf8"), "已清洗并生成报告");
});

test("临时角色定义无效或超量时直接报错", async (t) => {
  const roles3 = [1, 2, 3].map((n) => ({ name: `临时${n}`, description: "职责", access: "read" }));
  const fx = await fixture(t, { action: "run", subAgents: roles3, tasks: [{ ...task, role: "sub-1" }] });
  const result = await fx.run();
  assert.equal(result.kind, "error");
  assert.match(result.text, /临时角色最多 2 个/);
  assert.deepEqual(fx.events, []);
  assert.equal(fx.fetchMock.mock.callCount(), 1);
});

test("临时角色与现有角色重名时报错", async (t) => {
  const fx = await fixture(t, { action: "run",
    subAgents: [{ name: "执行 Agent", description: "重复", access: "write" }],
    tasks: [{ ...task, role: "sub-1" }] });
  const result = await fx.run();
  assert.equal(result.kind, "error");
  assert.match(result.text, /重名|无效/);
  assert.deepEqual(fx.events, []);
});

test("确认问题的自由回复会带上未决确认上下文重新规划并按选项执行", async (t) => {
  const clarifyFollowUp = { question: "深度学习当前文件夹，你想做哪个方向？", options: [
    { label: "只读盘点", task: "盘点全部文件", inputs: [], outputs: [] },
    { label: "交叉分析并落盘", task: "以订单与退款为基准核对汇总并生成报告",
      inputs: ["orders.csv"], outputs: ["报告.md"] } ] };
  const fx = await fixture(t, {}, ["orders.csv", "refunds.csv"]);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message = { content: "已完成。" };
    if (stage === "协作阶段：规划") {
      const input = JSON.parse(messages[1].content);
      assert.deepEqual(input.clarifyFollowUp.options.map(({ label }) => label), ["只读盘点", "交叉分析并落盘"]);
      message.content = JSON.stringify({ action: "run", tasks: [
        { id: "analysis", role: "execute", title: "交叉分析", goal: "生成报告",
          requiredInputs: ["orders.csv"], outputs: ["报告.md"], requiredAccess: "write",
          acceptance: "报告可读", dependsOn: [] } ] });
    }
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) message = { tool_calls: [{ id: "w1", type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "报告.md", content: "交叉分析完成" }) } }] };
    }
    if (stage === "协作阶段：验收") message.content = JSON.stringify({ passed: true, reason: "报告可读。" });
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run({ clarifyFollowUp });
  assert.equal(result.collaboration?.passed, true);
  assert.equal(await readFile(join(fx.workspaceDir, "报告.md"), "utf8"), "交叉分析完成");
});


test("自我循环重规划创建临时角色并完成交付", async (t) => {
  const fx = await fixture(t, {}, []);
  let plans = 0;
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message = { content: "已完成。" };
    if (stage === "协作阶段：规划") {
      plans++;
      if (plans === 1) {
        message = { content: JSON.stringify({ action: "run", tasks: [
          { ...task, outputs: ["报告.md"], requiredInputs: [] } ] }) };
      } else {
        const input = JSON.parse(messages[1].content);
        assert.match(input.correction ?? "", /未通过|失败/);
        message = { content: JSON.stringify({ action: "run",
          subAgents: [{ name: "数据撰写员", description: "专职重写退款报告。", access: "write" }],
          tasks: [{ ...task, role: "sub-1", outputs: ["报告.md"], requiredInputs: [] } ] }) };
      }
    }
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) message = { tool_calls: [{ id: `w-${plans}`, type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "报告.md",
          content: plans === 1 ? "草稿，缺合计" : "最终报告：合计 425.76（重写自临时角色）" }) } }] };
    }
    if (stage === "协作阶段：验收") {
      message = { content: JSON.stringify(plans === 1
        ? { passed: false, reason: "报告缺少退款合计，建议由专职撰写角色重写。" }
        : { passed: true, reason: "报告包含合计。" }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run({});
  assert.equal(result.kind, "reply");
  assert.equal(result.collaboration?.passed, true);
  const created = result.collaboration.canvasEvents.filter(({ type }) => type === "subagent.created");
  assert.equal(created.length, 1);
  assert.equal(created[0].roleName, "数据撰写员");
  const iterations = result.collaboration.canvasEvents.filter(({ type }) => type === "selfloop.iteration");
  assert.equal(iterations.length, 1);
  assert.equal(plans, 2);
  assert.equal(await readFile(join(fx.workspaceDir, "报告.md"), "utf8"), "最终报告：合计 425.76（重写自临时角色）");
});

test("重规划的临时角色与现有角色重名时返回分工错误并保留首轮验收原因", async (t) => {
  const fx = await fixture(t, {}, []);
  let plans = 0;
  const firstReason = "报告缺少退款合计，建议由专职撰写角色重写。";
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    let message = { content: "已完成。" };
    if (stage === "协作阶段：规划") {
      plans++;
      if (plans === 1) {
        message = { content: JSON.stringify({ action: "run", tasks: [
          { ...task, outputs: ["报告.md"], requiredInputs: [] } ] }) };
      } else {
        const input = JSON.parse(messages[1].content);
        assert.match(input.correction ?? "", /未通过|失败/);
        // 重名：与内置角色「执行 Agent」冲突
        message = { content: JSON.stringify({ action: "run",
          subAgents: [{ name: "执行 Agent", description: "与现有角色重名。", access: "write" }],
          tasks: [{ ...task, role: "sub-1", outputs: ["报告.md"], requiredInputs: [] } ] }) };
      }
    }
    if (stage === "协作阶段：执行") {
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) message = { tool_calls: [{ id: `w-${plans}`, type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "报告.md", content: "草稿" }) } }] };
    }
    if (stage === "协作阶段：验收") {
      message = { content: JSON.stringify({ passed: plans !== 1,
        reason: plans === 1 ? firstReason : "不该走到这里。" }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const result = await fx.run({});
  assert.equal(result.kind, "reply");
  assert.match(result.text, /重新规划失败/);
  assert.match(result.text, /重名|无效/);
  assert.match(result.text, /上一轮未通过验收/);
  assert.match(result.text, /缺少退款合计/); // 首轮验收原因被保留
  assert.ok(fx.events.some(({ type }) => type === "plan")); // 首轮确实执行过分工
});

test("Codex 角色使用指定执行器并将结果交给验收", async (t) => {
  const role = { id: "role-codex", name: "Codex 调研员", description: "只读核对材料", access: "read", executor: "codex" };
  const planned = { action: "run", tasks: [
    { ...task, role: role.id, goal: "核对退款依据", requiredAccess: "read", outputs: [] },
  ] };
  const fx = await fixture(t, planned, task.requiredInputs);
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    if (stage === "协作阶段：规划") {
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(planned) } }] }) };
    }
    if (stage === "协作阶段：验收") {
      assert.match(messages[1].content, /CODEX-RECEIPT/);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"passed":true,"reason":"已验收"}' } }] }) };
    }
    if (stage === "协作阶段：汇总") {
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Codex 结果已验收。" } }] }) };
    }
    assert.fail(`意外调用内置执行器：${stage}`);
  });
  const externalRunner = t.mock.fn(async ({ assignment, requiredInputs, workspaceDir, profile }) => {
    assert.equal(profile.executor, "codex");
    assert.equal(workspaceDir, fx.workspaceDir);
    assert.equal(assignment, planned.tasks[0].goal);
    assert.deepEqual(requiredInputs, task.requiredInputs);
    return { text: "CODEX-RECEIPT", outputs: [] };
  });
  const result = await fx.run({ customRoles: [role], externalRunner });
  assert.equal(externalRunner.mock.callCount(), 1);
  assert.equal(result.collaboration?.passed, true);
  assert.ok(fx.events.some((event) => event.type === "task.handoff" && event.from === role.id));
  assert.deepEqual((await readdir(fx.workspaceDir)).sort(), [...task.requiredInputs].sort());
});

test("Codex 协调者负责规划与汇总，执行和验收仍经编排器", async (t) => {
  const planned = { action: "run", tasks: [
    { ...task, role: "research", goal: "核对退款依据", requiredAccess: "read", outputs: [] },
  ] };
  const fx = await fixture(t, planned, task.requiredInputs);
  const canvas = {
    nodes: ["coordinator", "research", "reviewer"].map((id) => ({ id, x: .5, y: .5 })),
    edges: [], configured: false, coordinatorExecutor: "codex",
  };
  const internalStages = [];
  fx.fetchMock.mock.mockImplementation(async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const stage = messages[0].content.split("\n")[0];
    internalStages.push(stage);
    const content = stage === "协作阶段：验收"
      ? '{"passed":true,"reason":"已核对内部执行结果"}' : "已核对工作区材料。";
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  const coordinatorRunner = t.mock.fn(async ({ stage, messages, workspaceDir }) => {
    assert.equal(workspaceDir, fx.workspaceDir);
    if (stage === "规划") {
      assert.match(messages[0].content, /总协调者/);
      return JSON.stringify(planned);
    }
    assert.equal(stage, "汇总");
    assert.match(messages[1].content, /已核对工作区材料/);
    return "Codex 已汇总验收结果。";
  });
  const result = await fx.run({ canvas, coordinatorRunner });
  assert.deepEqual(coordinatorRunner.mock.calls.map(({ arguments: [input] }) => input.stage), ["规划", "汇总"]);
  assert.deepEqual(internalStages, ["协作阶段：调研", "协作阶段：验收"]);
  assert.equal(result.text, "Codex 已汇总验收结果。");
  assert.ok(fx.events.some(({ type, from, to }) => type === "task.handoff" && from === "research" && to === "reviewer"));
});

test("Codex 协调者不可用时停止派发并显示原因", async (t) => {
  const fx = await fixture(t, { action: "run", tasks: [task] }, task.requiredInputs);
  const canvas = {
    nodes: ["coordinator", "execute", "reviewer"].map((id) => ({ id, x: .5, y: .5 })),
    edges: [], coordinatorExecutor: "codex",
  };
  const result = await fx.run({
    canvas,
    coordinatorRunner: async () => { throw new Error("Codex 离线"); },
  });
  assert.equal(result.kind, "error");
  assert.match(result.text, /Codex 离线/);
  assert.equal(fx.fetchMock.mock.callCount(), 0);
  assert.deepEqual(fx.events, []);
});

test("画布可分别选择协调者、执行角色和验收者的执行器", async (t) => {
  const fx = await fixture(t, {}, ["orders.csv"]);
  const planned = { action: "run", tasks: [{
    ...task, requiredInputs: ["orders.csv"], requiredAccess: "read", outputs: [], role: "research",
  }] };
  const canvas = {
    nodes: ["coordinator", "research", "reviewer"].map((id) => ({ id, x: .5, y: .5 })),
    edges: [], configured: false, roleExecutors: { coordinator: "dsh", research: "codex", reviewer: "codex" },
  };
  const roleCalls = [];
  const coordinatorRunner = async ({ stage, executor }) => {
    roleCalls.push([stage, executor]);
    if (stage === "规划") return JSON.stringify(planned);
    if (stage === "验收") return '{"passed":true,"reason":"核对通过"}';
    return "已由选定协调者汇总。";
  };
  const externalRunner = async ({ profile }) => {
    roleCalls.push([profile.id, profile.executor]);
    return { text: "已核对源文件。", outputs: [] };
  };
  const result = await fx.run({ canvas, coordinatorRunner, externalRunner });
  assert.deepEqual(roleCalls, [["规划", "dsh"], ["research", "codex"], ["验收", "codex"], ["汇总", "dsh"]]);
  assert.equal(fx.fetchMock.mock.callCount(), 0);
  assert.equal(result.collaboration.passed, true);
});

for (const executor of ["hermes", "openclaw"]) test(`${executor} 可选为协调者及读写执行者，权限传到运行器`, async (t) => {
  const fx = await fixture(t, {}, []);
  const canvas = {
    nodes: ["coordinator", "research", "execute", "reviewer"].map((id) => ({ id, x: .5, y: .5 })),
    edges: [], roleExecutors: { coordinator: executor, research: executor },
  };
  const approveAction = async () => true;
  const runner = t.mock.fn(async ({ executor, access, approveAction: approval }) => {
    assert.ok(["hermes", "openclaw"].includes(executor));
    assert.equal(access, "read");
    assert.equal(approval, approveAction);
    return '{"action":"reply","text":"Hermes 已接收。"}';
  });
  assert.equal((await fx.run({ canvas, coordinatorRunner: runner, approveAction })).text, "Hermes 已接收。");
  assert.equal((await fx.run({ canvas: { ...canvas, roleExecutors: { coordinator: executor, execute: executor } }, coordinatorRunner: runner, approveAction })).text, "Hermes 已接收。");
  assert.equal(runner.mock.callCount(), 2);
  assert.equal(fx.fetchMock.mock.callCount(), 0);
});

test("用户配置的角色指令和模型实际传入对应执行器", async(t) => {
  const fx=await fixture(t,{});
  const canvas={nodes:["coordinator","research","reviewer"].map(id=>({id,x:.5,y:.5})),edges:[],
    roleExecutors:{coordinator:"hermes"},
    roleSettings:{coordinator:{instructions:"优先核对合同编号",modelId:"chosen-model",memory:"persistent"}}};
  const runner=t.mock.fn(async ({messages,config,settings,stateRoot,roleId})=>{
    assert.match(messages[0].content,/优先核对合同编号/);
    assert.equal(config.modelId,"chosen-model");
    assert.equal(settings.memory,"persistent");
    assert.equal(roleId,"coordinator");
    assert.equal(stateRoot,fx.workspaceDir);
    return '{"action":"reply","text":"已使用用户设置。"}';
  });
  const result=await fx.run({canvas,coordinatorRunner:runner,executorStateRoot:fx.workspaceDir});
  assert.equal(result.text,"已使用用户设置。");
  assert.equal(runner.mock.callCount(),1);
});
