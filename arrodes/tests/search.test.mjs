import assert from "node:assert/strict";
import test from "node:test";
import { describeTurnTools, READ_TOOL_NAMES, runAgentTurn } from "../agent/loop.mjs";

test("网页和 GitHub 搜索可用于普通对话与只读角色，能力说明与实际工具一致", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "可以查找资料" } }] }) };
  });
  const turn = { text: "在 GitHub 找 PDF 文本提取库", history: [], workspaceDir: process.cwd(),
    config: { baseUrl: "https://example.invalid", modelId: "fixture" } };
  await runAgentTurn(turn);
  await runAgentTurn({ ...turn, collaboration: { stage: "调研", instructions: "", tools: READ_TOOL_NAMES } });
  for (const request of requests) {
    for (const name of ["search_web", "search_github", "research_web"]) {
      assert.ok(request.tools.some((tool) => tool.function.name === name), name);
      assert.ok(request.messages[0].content.includes(name), name);
    }
    assert.doesNotMatch(request.messages[0].content, /没有按关键词搜索/);
  }
  assert.doesNotMatch(describeTurnTools([]), /可以按关键词/);
});
import { parseWebResults, searchPublic } from "../agent/web-search.mjs";

test("解析正常结果与 Bing 跳转，过滤非 HTTPS 链接", () => {
  const encoded = Buffer.from("https://example.com/source").toString("base64url");
  const item = (link, title) => `<li class="b_algo"><h2><a href="${link}">${title}</a></h2><p>摘要</p></li>`;
  assert.deepEqual(parseWebResults(item("/ck/a?u=a1" + encoded, "资料") + item("http://example.com", "忽略")),
    [{ title: "资料", url: "https://example.com/source", snippet: "摘要" }]);
});

test("只允许 Bing 搜索域内跳转，GitHub 受限时返回可读错误", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (url) => {
    if (url.hostname === "www.bing.com") return new Response(null, { status: 302, headers: { location: "https://cn.bing.com/search?q=test" } });
    if (url.hostname === "cn.bing.com") return new Response('<li class="b_algo"><h2><a href="https://example.com/">结果</a></h2></li>');
    return new Response(null, { status: 403 });
  });
  assert.equal((await searchPublic("search_web", { query: "test" })).results[0].url, "https://example.com/");
  await assert.rejects(searchPublic("search_github", { query: "test" }), /限流/);
  mock.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/search" } }));
  await assert.rejects(searchPublic("search_web", { query: "test" }), /不受支持的跳转/);
});
