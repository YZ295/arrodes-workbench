import assert from "node:assert/strict";
import test from "node:test";
import { deepSeekModelId } from "../agent/deepseek.mjs";
import { requestModel } from "../agent/loop.mjs";

const official = "https://api.deepseek.com/v1";

test("旧 DeepSeek 官方配置切换到 Flash，其他模型与网关保留", () => {
  assert.equal(deepSeekModelId(official, "deepseek-chat"), "deepseek-flash");
  assert.equal(deepSeekModelId(official, ""), "deepseek-flash");
  assert.equal(deepSeekModelId(official, "deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(deepSeekModelId("https://gateway.example/v1", "deepseek-chat"), "deepseek-chat");
});

test("官方 Flash 请求与工具循环兼容，第三方请求不带 DeepSeek 参数", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "ok" } }] }),
  }));
  const messages = [{ role: "user", content: "你好" }];
  const tools = [{ type: "function", function: { name: "list_dir" } }];
  const config = { baseUrl: official, modelId: "deepseek-chat", apiKey: "fixture" };
  await requestModel(config, messages, tools);
  await requestModel({ ...config, baseUrl: "https://gateway.example/v1" }, messages, tools);

  const [first, second] = fetchMock.mock.calls.map(({ arguments: [, options] }) => JSON.parse(options.body));
  assert.equal(first.model, "deepseek-flash");
  assert.deepEqual(first.thinking, { type: "disabled" });
  assert.deepEqual(first.tools, tools);
  assert.equal(second.model, "deepseek-chat");
  assert.equal(second.thinking, undefined);
});
