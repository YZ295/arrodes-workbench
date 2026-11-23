import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMarketplace } from "../agent/marketplace.mjs";
import { createTeamSkillStore } from "../agent/team-skills.mjs";

test("社区 Skill 更新保留角色引用，卸载检查绑定", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "arrodes-market-test-"));
  try {
    const teamSkills = createTeamSkillStore(dataDir);
    let version = "1.0.0";
    let bound = false;
    const market = createMarketplace({
      dataDir, teamSkills, checkIdle() {},
      checkSkillUnused(_id, unlink) {
        if (bound && !unlink) throw new Error("仍被角色使用");
        bound = false;
      },
      async fetcher(input) {
        const url = new URL(input);
        const source = "https://github.com/example/project/blob/main/SKILL.md";
        if (url.hostname === "raw.githubusercontent.com") return Response.json([
          { id: "community-skill", kind: "skill", category: "测试", name: "社区技能",
            description: "测试更新", author: "example", version, source },
        ]);
        const content = Buffer.from(`---\nname: 社区技能\n---\n写明版本 ${version}。`);
        return Response.json({ type: "file", encoding: "base64", size: content.length, content: content.toString("base64") });
      },
    });
    await market.refresh();
    const installed = (await market.install("community-skill")).installed["community-skill"];
    bound = true;
    version = "1.1.0";
    assert.deepEqual((await market.refresh()).updates, ["community-skill"]);
    const updated = (await market.install("community-skill", true)).installed["community-skill"];
    assert.equal(updated.skillId, installed.skillId);
    assert.match(teamSkills.list().find(({ id }) => id === updated.skillId).instructions, /1\.1\.0/);
    assert.throws(() => market.remove("community-skill"), /仍被角色使用/);
    assert.equal(Object.hasOwn(market.remove("community-skill", true).installed, "community-skill"), false);
    assert.equal(teamSkills.list().some(({ id }) => id === updated.skillId), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
