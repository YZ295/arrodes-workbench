import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeSession } from "../agent/native-sessions.mjs";
import { runAcpAgent } from "../agent/acp-executor.mjs";

test("所有原生 Agent 的会话按执行器、工作区和角色隔离", async t => {
  const root=await mkdtemp(join(tmpdir(),"arrodes-native-sessions-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const context={workspaceDir:root,roleId:"coordinator",stateRoot:join(root,"state"),settings:{memory:"persistent"}};
  for(const executor of ["codex","workbuddy","claude","dsh","hermes","openclaw"]){
    const first=await nativeSession(executor,context);assert.equal(first.id,undefined);
    await first.save(`${executor}-native-id`);
    assert.equal((await nativeSession(executor,context)).id,`${executor}-native-id`);
    assert.equal((await nativeSession(executor,{...context,roleId:"reviewer"})).id,undefined);
    assert.equal((await nativeSession(executor,{...context,workspaceDir:join(root,"other")})).id,undefined);
    assert.equal((await nativeSession(executor,{...context,settings:{memory:"ephemeral"}})).id,undefined);
  }
});

test("原生 ACP 拒绝只读角色写入，转交命令授权，并忽略恢复时的旧消息", async () => {
  const script=`
    const rl=require('node:readline').createInterface({input:process.stdin});
    const emit=v=>console.log(JSON.stringify({jsonrpc:'2.0',...v}));let prompt;
    rl.on('line',line=>{const m=JSON.parse(line);
      const reply=result=>emit({id:m.id,result});
      if(m.method==='initialize')reply({agentCapabilities:{loadSession:true}});
      else if(m.method==='session/load'){
        emit({method:'session/update',params:{sessionId:'native-id',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_HISTORY'}}}});reply({});
      }else if(m.method==='session/prompt'){
        prompt=m.id;emit({id:'edit',method:'session/request_permission',params:{toolCall:{kind:'edit',rawInput:{path:'must-not-write.txt'}},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});
      }else if(m.id==='edit'){
        if(m.result.outcome.optionId!=='no')process.exit(5);
        emit({id:'exec',method:'session/request_permission',params:{toolCall:{kind:'execute',rawInput:{command:'echo explicit'}},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});
      }else if(m.id==='exec'){
        if(m.result.outcome.optionId!=='no')process.exit(6);
        emit({method:'session/update',params:{sessionId:'native-id',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'NATIVE_DENIED'}}}});
        emit({id:prompt,result:{stopReason:'end_turn'}});
      }
    });rl.on('close',()=>process.exit(0));`;
  let approvals=0,saved;
  const result=await runAcpAgent({executable:process.execPath,args:["-e",script],env:process.env},{
    cwd:process.cwd(),input:"Native operation",writing:false,label:"Native fixture",
    session:{id:"native-id",save:async id=>saved=id},approveAction:async request=>{approvals++;assert.match(request.detail,/echo explicit/);return false;},
  });
  assert.equal(result,"NATIVE_DENIED");assert.equal(saved,"native-id");assert.equal(approvals,1);
});
