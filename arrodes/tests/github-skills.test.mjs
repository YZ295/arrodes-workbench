import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGithubSkill } from "../agent/github-skills.mjs";

const bytes = Buffer.from("---\nname: sample\ndescription: Fixture\n---\n\nInspect the input.");
const file = () => Response.json({ type: "file", encoding: "base64", content: bytes.toString("base64"), size: bytes.length });
const origin = "https://api.github.com";

test("目录、文件和 raw 地址指向同一份 Markdown", async () => {
  for (const link of [
    "https://github.com/owner/repo/tree/main/skills/sample",
    "https://github.com/owner/repo/blob/main/skills/sample/SKILL.md?plain=1",
    "https://raw.githubusercontent.com/owner/repo/refs/heads/main/skills/sample/SKILL.md",
  ]) {
    const result = await fetchGithubSkill(link, async (url, options) => {
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, "/repos/owner/repo/contents/skills/sample/SKILL.md");
      assert.ok(["main", "refs/heads/main"].includes(url.searchParams.get("ref")));
      assert.equal(options.redirect, "error");
      return file();
    });
    assert.deepEqual(result.bytes, bytes);
  }
});

test("含斜杠的分支名可以在首个候选不存在时继续解析", async () => {
  const result = await fetchGithubSkill("https://github.com/owner/repo/blob/feature/import/skills/sample/SKILL.md",
    async (url) => url.searchParams.get("ref") === "feature/import" ? file() : new Response(null, { status: 404 }));
  assert.equal(result.path, "skills/sample/SKILL.md");
});

test("非公开 GitHub 地址在网络请求前拒绝", async () => {
  for (const url of ["https://github.com.example/owner/repo", "http://github.com/owner/repo", "https://name@github.com/owner/repo", "https://github.com/owner/repo/blob/main/setup.sh"]) {
    await assert.rejects(fetchGithubSkill(url, () => assert.fail("不应请求网络")), /请输入公开 GitHub/);
  }
});

test("404、限流和超限内容给出可识别的错误", async () => {
  const url = "https://github.com/owner/repo/blob/main/SKILL.md";
  await assert.rejects(fetchGithubSkill(url, async () => new Response(null, { status: 404 })), /没有找到/);
  await assert.rejects(fetchGithubSkill(url, async () => new Response(null, { status: 429 })), /请求过多/);
  await assert.rejects(fetchGithubSkill(url, async () =>
    Response.json({ type: "file", encoding: "base64", content: bytes.toString("base64"), size: 33000 })), /32 KB/);
});
