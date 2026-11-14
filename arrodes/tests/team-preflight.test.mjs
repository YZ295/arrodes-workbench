import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTeamTurn } from "../agent/team.mjs";

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
    run: () => runTeamTurn({
      text: "核对工作区的订单和退款并生成报告", history: [], workspaceDir, config,
      onCanvasEvent: (event) => events.push(event),
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
