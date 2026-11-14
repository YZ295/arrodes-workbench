import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTurn } from "../agent/loop.mjs";

test("明确的打开工作区请求直接调用桌面工具，旧会话不能改变路由", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: "开不了" } }] }),
  }));
  const opened = [];
  const result = await runAgentTurn({
    text: "打开文件夹", workspaceDir: process.cwd(), config: { baseUrl: "https://example.invalid" },
    history: [{ role: "assistant", content: "不能打开文件夹" }],
    approveAction: async () => true, openItem: async (path) => { opened.push(path); return ""; },
  });
  assert.equal(opened.length, 1);
  assert.match(result.text, /已打开/);
});
test("创造模式修改源码前展示差异，拒绝则保留原文件", async (t) => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const workspaceDir = await mkdtemp(join(tmpdir(), "arrodes-creator-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const file = join(workspaceDir, "agent.mjs");
  await writeFile(file, "export const value = 1;\n");
  const approvals = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true, json: async () => ({ choices: [{ message: ++calls % 2 === 0 ? { content: "完成" } : {
      role: "assistant", tool_calls: [{ id: "write", function: { name: "write_file",
        arguments: JSON.stringify({ path: "agent.mjs", content: "export const value = 2;\n" }) } }],
    } }] }),
  }));
  const turn = (approve) => runAgentTurn({
    text: "修改源码", workspaceDir, history: [], config: { baseUrl: "https://example.invalid" },
    creator: true, approveAction: async (request) => { approvals.push(request); return approve; },
  });
  await turn(false);
  assert.equal(await readFile(file, "utf8"), "export const value = 1;\n");
  assert.match(approvals[0].detail, /- export const value = 1;/);
  assert.match(approvals[0].detail, /\+ export const value = 2;/);
  await turn(true);
  assert.equal(await readFile(file, "utf8"), "export const value = 2;\n");
});
