import assert from "node:assert/strict";
import test from "node:test";
import { listAvailableModels, resolveModelConnection, testModelConnection } from "../agent/model-connection.mjs";

const config = { baseUrl: "https://gateway.example/v1", apiKey: "fixture", modelId: "model-a" };

test("only the saved endpoint can reuse its key", () => {
  assert.deepEqual(resolveModelConnection({ baseUrl: config.baseUrl + "/", modelId: config.modelId }, config), config);
  assert.match(resolveModelConnection({ baseUrl: "https://another.example/v1" }, config).error, /API Key/);
  assert.match(resolveModelConnection({ baseUrl: "https://gateway.example/another" }, config).error, /API Key/);
  assert.match(resolveModelConnection({ baseUrl: "https://user@gateway.example/v1" }, config).error, /接口地址/);
});

test("model discovery reports the key's returned model IDs and preserves manual testing", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }, { id: null }],
  }));
  assert.deepEqual(await listAvailableModels(config), { models: ["model-a", "model-b"] });
  assert.equal(calls.mock.calls[0].arguments[0], config.baseUrl + "/models");
  assert.equal(calls.mock.calls[0].arguments[1].headers.authorization, "Bearer fixture");
  assert.equal(calls.mock.calls[0].arguments[1].redirect, "error");
  calls.mock.mockImplementation(async () => new Response(null, { status: 404 }));
  assert.match((await listAvailableModels(config)).error, /手动填写模型/);
  calls.mock.mockImplementation(async () => new Response(null, { status: 401 }));
  assert.match((await listAvailableModels(config)).error, /API Key/);
});

test("connection success requires an actual reply from the selected model", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: "" } }] }));
  assert.match((await testModelConnection(config)).error, /未返回可用/);
  assert.equal(calls.mock.calls[0].arguments[0], config.baseUrl + "/chat/completions");
  const request = JSON.parse(calls.mock.calls[0].arguments[1].body);
  assert.equal(request.model, config.modelId);
  assert.equal(request.messages.length, 1);
  assert.equal(request.tools, undefined);
  calls.mock.mockImplementation(async () => Response.json({ choices: [{ message: { content: "OK" } }] }));
  assert.deepEqual(await testModelConnection(config), { ok: true });
});
