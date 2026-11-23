import assert from "node:assert/strict";
import test from "node:test";
import { supportedExecutors, teamExecutorOptions } from "../agent/external-executors.mjs";
import { validateCanvas } from "../agent/team-canvas.mjs";
import { getTeamRoles, runTeamTurn } from "../agent/team.mjs";

for (const executor of ["codex", "workbuddy", "hermes", "claude", "dsh", "openclaw"]) {
  test(`${executor} 遵循原生配置契约且角色可延续原生会话`, () => {
    assert.ok(supportedExecutors.includes(executor));
    const option = teamExecutorOptions(null).find(({ id }) => id === executor);
    assert.equal(option.usesArrodesModel, false);
    assert.equal(option.supportsSession, true);
    assert.equal(option.supportsModel, true);
    assert.match(option.detail, /原生|自己的|自身/);
    const graph=validateCanvas({nodes:["coordinator","reviewer"].map(id=>({id,x:.5,y:.5})),edges:[],
      roleExecutors:{coordinator:executor},roleSettings:{coordinator:{memory:"persistent",modelId:"native-chosen"}}},getTeamRoles());
    assert.equal(graph.roleSettings.coordinator.memory,"persistent");
  });
}

test("外部协调者不会收到内置空工具清单或禁用原生 Skill 的提示", async () => {
  for(const executor of ["codex","workbuddy","hermes","claude","dsh","openclaw"]){
    const result=await runTeamTurn({text:"说明你的原生能力",history:[],workspaceDir:process.cwd(),config:null,
      canvas:{nodes:["coordinator","reviewer"].map(id=>({id,x:.5,y:.5})),edges:[],roleExecutors:{coordinator:executor}},
      coordinatorRunner:async({messages})=>{
        assert.doesNotMatch(messages[0].content,/当前阶段没有网页工具|对话不能创建或修改角色、安装或分配 Skill/);
        assert.match(messages[0].content,/原生运行时|原生能力/);
        return '{"action":"reply","text":"使用原生能力"}';
      }});
    assert.equal(result.text,"使用原生能力");
  }
});
