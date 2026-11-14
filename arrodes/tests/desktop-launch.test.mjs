import assert from "node:assert/strict";
import test from "node:test";
import { READ_TOOL_NAMES, runAgentTurn } from "../agent/loop.mjs";

test("桌面启动工具只接受支持的目标并在执行前请求确认", async (t) => {
  let action, result, offered;
  const mock = t.mock.method(globalThis, "fetch", async (_, options) => {
    const request = JSON.parse(options.body);
    const last = request.messages.at(-1);
    if (last.role === "tool") {
      result = JSON.parse(last.content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "完成" } }] }) };
    }
    offered = request.tools.map(({ function: tool }) => tool.name);
    return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", tool_calls: [
      { id: "launch", function: { name: "open_desktop", arguments: JSON.stringify(action) } },
    ] } }] }) };
  });
  const approvals = [], launched = [];
  const turn = async (args, approve, collaboration) => {
    action = args;
    await runAgentTurn({ text: "打开", history: [], workspaceDir: process.cwd(),
      config: { baseUrl: "https://example.invalid", modelId: "test" }, collaboration,
      approveAction: async (request) => { approvals.push(request); return approve; },
      launchDesktop: async (target) => { launched.push(target); },
    });
    return result;
  };
  assert.equal((await turn({ target: "recycle_bin" }, true)).ok, true);
  assert.ok(offered.includes("open_desktop"));
  assert.equal((await turn({ target: "browser" }, false)).ok, false);
  assert.equal((await turn({ target: "browser", url: "file:///C:/test" }, true)).ok, false);
  assert.equal((await turn({ target: "browser", url: "https://example.com/" }, true)).ok, true);
  assert.equal((await turn({ target: "powershell" }, true)).ok, false);
  assert.equal((await turn({ target: "recycle_bin" }, true, { stage: "调研", instructions: "", tools: READ_TOOL_NAMES })).ok, false);
  assert.equal(approvals.length, 3);
  assert.deepEqual(launched, [{ target: "recycle_bin" }, { target: "browser", url: "https://example.com/" }]);
  mock.mock.restore();
});
