import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAgentTurn, verifyWorkspaceFile } from "../agent/loop.mjs";

test("真实工具循环搜索、读取、导出、验收表格，并约束角色与高权限工具", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arrodes-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "input.csv"), 'item,amount\r\n"a,b",2\r\n', "utf8");
  const toolResult = [];
  const turn = async (name, args, collaboration, approveAction) => {
    const mock = t.mock.method(globalThis, "fetch", async (_url, request) => {
      const payload = JSON.parse(request.body);
      if (payload.messages.at(-1).role === "tool") {
        toolResult.push(JSON.parse(payload.messages.at(-1).content));
        return { ok: true, json: async () => ({ choices: [{ message: { content: "done" } }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: {
        role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
      } }] }) };
    });
    try {
      await runAgentTurn({ text: "执行", history: [], workspaceDir: root, config: {
        baseUrl: "https://example.com", modelId: "fixture", apiKey: "fixture",
      }, collaboration, approveAction });
      return toolResult.at(-1);
    } finally { mock.mock.restore(); }
  };
  assert.match((await turn("search_workspace", { query: "input.csv" })).output, /input.csv/);
  const readOnly = { stage: "调研", instructions: "", tools: ["read_table"] };
  assert.match((await turn("read_table", { path: "input.csv" }, readOnly)).output, /a,b/);
  assert.equal((await turn("export_xlsx", { path: "result.xlsx", rows: [["金额"], [2]] }, readOnly)).ok, false);
  assert.equal((await turn("export_xlsx", { path: "result.xlsx", rows: [["金额"], [2]] })).ok, true);
  assert.equal((await readFile(join(root, "result.xlsx"))).subarray(0, 2).toString(), "PK");
  assert.equal((await verifyWorkspaceFile(root, "result.xlsx")).ok, true);
  await writeFile(join(root, "bad.xlsx"), "invalid");
  assert.equal((await verifyWorkspaceFile(root, "bad.xlsx")).ok, false);
  assert.equal((await turn("read_document", { path: "../outside.pdf" })).ok, false);
  assert.equal((await turn("research_web", { url: "http://127.0.0.1/" })).ok, false);
  assert.match((await turn("read_document", { path: "input.csv", start: 2 })).output, /a,b/);
  assert.equal(JSON.parse((await turn("summarize_table", { path: "input.csv", column: 2 })).output).total, 2);
  assert.equal((await turn("verify_file", { path: "result.xlsx", cell: "A2", expected: 2 })).ok, true);
  assert.equal((await turn("verify_file", { path: "result.xlsx", cell: "A2", expected: 3 })).ok, false);
  const move = { paths: ["input.csv"], directory: "archive" };
  assert.match((await turn("preview_archive", move)).output, /archive/);
  assert.equal((await turn("archive_files", move, undefined, async () => false)).ok, false);
  assert.equal((await turn("archive_files", move, undefined, async () => true)).ok, true);
  assert.match(await readFile(join(root, "archive", "input.csv"), "utf8"), /item/);
  await assert.rejects(readFile(join(root, "input.csv")), { code: "ENOENT" });
  let prompted = 0;
  assert.equal((await turn("run_project_check", { path: "a.test.js" }, undefined, async () => { prompted++; return false; })).ok, false);
  assert.equal(prompted, 1);
  await writeFile(join(root, "a.test.js"), 'require("node:test")("fixture", () => {});');
  assert.match((await turn("run_project_check", { path: "a.test.js" }, undefined, async () => true)).output, /fixture/);
});

test("模型请求明确声明当前工具，避免旧会话把联网误报为不可用", async (t) => {
  const captured = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    captured.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "回答" } }] }) };
  });
  const options = {
    text: "你可以联网吗？",
    history: [{ role: "assistant", content: "我只有四个工具，不能联网。" }],
    workspaceDir: tmpdir(), config: { baseUrl: "https://example.com", modelId: "fixture" },
  };
  await runAgentTurn(options);
  await runAgentTurn({ ...options, collaboration: { stage: "协助", instructions: "", tools: ["read_file"] } });
  assert.ok(captured[0].tools.some(({ function: tool }) => tool.name === "research_web"));
  assert.match(captured[0].messages[0].content, /本轮可调用工具：.*research_web/);
  assert.match(captured[0].messages[0].content, /读取指定的公开 HTTPS 网页/);
  assert.doesNotMatch(captured[1].messages[0].content, /本轮可调用工具：.*research_web/);
});
