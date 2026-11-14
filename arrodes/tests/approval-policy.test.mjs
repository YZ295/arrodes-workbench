import assert from "node:assert/strict";
import test from "node:test";
import { approveOperation } from "../agent/approval-policy.mjs";

test("权限档位只跳过相应确认，未知档位按默认处理", async () => {
  const opened = { action: "打开桌面项目", detail: "workspace", risk: "routine" };
  const script = { action: "运行 PowerShell", script: "Get-Location" };
  const patch = { action: "应用源码修改" };
  const asked = [];
  const ask = (request) => { asked.push(request); return false; };
  assert.equal(await approveOperation("ask", opened, ask), false);
  assert.equal(await approveOperation("assist", opened, ask), true);
  assert.equal(await approveOperation("assist", script, ask), false);
  assert.equal(await approveOperation("assist", patch, ask), false);
  assert.equal(await approveOperation("full", script, ask), true);
  assert.equal(await approveOperation("full", patch, ask), true);
  assert.equal(await approveOperation("bad", opened, ask), false);
  assert.deepEqual(asked, [opened, script, patch, opened]);
});
