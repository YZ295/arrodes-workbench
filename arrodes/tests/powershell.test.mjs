import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { READ_TOOL_NAMES, runAgentTurn } from "../agent/loop.mjs";

test("PowerShell executes in the workspace after confirmation and reports real status", { skip: process.platform !== "win32" }, async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "arrodes-powershell-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  let script, result;
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const { messages } = JSON.parse(options.body);
    const last = messages.at(-1);
    if (last.role === "tool") result = JSON.parse(last.content);
    return { ok: true, json: async () => ({ choices: [{ message: last.role === "tool"
      ? { content: "done" } : { role: "assistant", tool_calls: [{ id: "ps", function: {
        name: "run_powershell", arguments: JSON.stringify({ script }),
      } }] } }] }) };
  });
  const approvals = [];
  const turn = async (input, approved, collaboration) => {
    script = input;
    await runAgentTurn({ text: "用 PowerShell 执行", history: [], workspaceDir, collaboration,
      config: { baseUrl: "https://example.invalid", modelId: "fixture" },
      approveAction: async (request) => { approvals.push(request); return approved; },
    });
    return result;
  };
  const write = "Set-Content -LiteralPath result.txt -Value 42; Write-Output '中文完成'";
  assert.equal((await turn(write, false)).ok, false);
  await assert.rejects(readFile(join(workspaceDir, "result.txt")), { code: "ENOENT" });
  assert.equal((await turn(write, true)).ok, true);
  assert.match(result.output, /中文完成/);
  assert.equal((await readFile(join(workspaceDir, "result.txt"), "utf8")).trim(), "42");
  assert.equal((await turn("exit 7", true)).exitCode, 7);
  assert.equal(result.ok, false);
  assert.equal((await turn("throw 'fixture error'", true)).ok, false);
  assert.equal((await turn(write, true, { stage: "调研", instructions: "", tools: READ_TOOL_NAMES })).ok, false);
  assert.equal(approvals.length, 4);
  assert.ok(approvals[0].detail.includes(write) && approvals[0].detail.includes(workspaceDir));
});
