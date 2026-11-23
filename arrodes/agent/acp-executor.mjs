import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { safePath } from "./loop.mjs";
import { nativeToolPermission } from "./native-process.mjs";
import appPackage from "../package.json" with { type: "json" };

const requestTimeout = 240_000;

export function openNativeRpc(executable, args, { cwd, env, label, onRequest, onNotification }) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  let nextId = 0, stopped = false;
  const send = value => { if (!stopped && child.stdin.writable) child.stdin.write(JSON.stringify(value) + "\n"); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error(`${label} 原生连接已关闭。`)); }
    waiting.clear(); lines.close(); child.stdin.end();
    const timer=setTimeout(()=>child.kill(),1500);timer.unref();child.once("close",()=>clearTimeout(timer));
  };
  child.stdin.on("error", () => {});
  child.stderr.on("data", () => {});
  child.once("error", stop); child.once("close", stop);
  lines.on("line", async line => {
    let message;
    try { message=JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      try { send({jsonrpc:"2.0",id:message.id,result:await onRequest?.(message.method,message.params??{})}); }
      catch { send({jsonrpc:"2.0",id:message.id,error:{code:-32000,message:"Arrodes permission or client operation denied"}}); }
    } else if(message.method) onNotification?.(message.method,message.params??{});
    else if(waiting.has(message.id)) {
      const item=waiting.get(message.id);waiting.delete(message.id);clearTimeout(item.timer);
      if(message.error) {
        const error=new Error(/auth|login|credential|api.?key/i.test(message.error.message??"")
          ? `${label} 需要在自己的原生配置中登录或连接模型。` : `${label} 无法完成原生协议请求（${message.error.code}）。`);
        error.code=message.error.code;item.reject(error);
      }else item.resolve(message.result);
    }
  });
  return {
    request(method,params={}) { return new Promise((resolve,reject)=>{
      if(stopped) return reject(new Error(`${label} 原生连接已关闭。`));
      const id=++nextId;
      const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`${label} 原生协议请求超时。`));},requestTimeout);
      waiting.set(id,{resolve,reject,timer});send({jsonrpc:"2.0",id,method,params});
    }); },
    notify:(method,params)=>send({jsonrpc:"2.0",method,params}), close:stop,
  };
}

export async function runAcpAgent(runtime, { cwd, input, writing, session, model, approveAction, onProgress, label }) {
  let collecting=false, text="", sessionId, terminalTimer;
  const terminal = Promise.withResolvers();
  const rpc=openNativeRpc(runtime.executable,runtime.args,{cwd,env:runtime.env,label,
    onNotification(method,params) {
      if(method!=="session/update"||!collecting||params.sessionId!==sessionId)return;
      const update=params.update;
      if(update?.sessionUpdate==="agent_message_chunk"&&update.content?.type==="text")text+=update.content.text;
      if(update?.sessionUpdate==="agent_message"&&update.content?.type==="text")text=update.content.text;
      if(update?.sessionUpdate==="tool_call") {text="";onProgress?.(`${label} · ${update.title??update.kind??"原生工具"}`);}
      if(runtime.harness && update?.sessionUpdate==="state_update" && update.state==="idle" && update.stopReason) terminal.resolve(update);
    },
    async onRequest(method,params) {
      if(method==="elicitation/create" && runtime.harness) return {action:"cancel"};
      if(method==="session/request_permission") {
        const call=params.toolCall??{};
        let allowed=false;
        if(call.kind!=="edit"||writing) {
          const raw=call.rawInput??{};
          const name=raw.toolName??raw.tool_name??call._meta?.toolName??call.kind??"native_tool";
          const args=raw.arguments??raw.input??raw;
          allowed=await nativeToolPermission({name,args,workspaceDir:cwd,writing,approveAction,label});
        }
        const option=params.options?.find(o=>o.kind===(allowed?"allow_once":"reject_once"));
        return {outcome:option?{outcome:"selected",optionId:option.optionId}:{outcome:"cancelled"}};
      }
      if(method==="fs/read_text_file"||method==="fs/write_text_file") {
        const path=safePath(cwd,relative(cwd,params.path));
        if(method==="fs/read_text_file")return {content:await readFile(path,"utf8")};
        if(!writing)throw new Error("Read-only role");
        await writeFile(path,params.content,"utf8");return {};
      }
      throw new Error("Unsupported native client operation");
    },
  });
  try {
    const clientInfo={name:"arrodes",version:appPackage.version};
    const init=await rpc.request("initialize",{protocolVersion:runtime.protocolVersion??1,clientInfo,
      ...(runtime.harness?{capabilities:{agent:{elicitation:{form:{},url:{}}}}}:{clientCapabilities:{fs:{readTextFile:true,writeTextFile:writing},terminal:false}})});
    if(runtime.harness)rpc.notify("initialized",{});
    const capabilities=init.agentCapabilities??init.capabilities??{};
    let result;
    if(session.id) {
      const method=runtime.harness||capabilities.sessionCapabilities?.resume?"session/resume":"session/load";
      result=await rpc.request(method,{sessionId:session.id,cwd,mcpServers:[]});sessionId=session.id;
    }else{
      result=await rpc.request("session/new",{cwd,mcpServers:[]});sessionId=result.sessionId;
    }
    if(model) {
      const option=result.configOptions?.find(o=>o.category==="model"||o.id==="model");
      await rpc.request(option?"session/set_config_option":"session/set_model",option
        ?{sessionId,configId:option.id,value:model}:{sessionId,modelId:model});
    }
    const modeId = writing ? "workspace-write" : "read-only";
    const availableMode = result.modes?.availableModes?.some((mode) => mode.id === modeId);
    if (availableMode) await rpc.request("session/set_mode", { sessionId, modeId });
    else if (runtime.harness && !runtime.connectionProbe) throw new Error(`${label} 未提供此角色所需的原生权限模式。`);
    collecting=true;
    let answer=await rpc.request("session/prompt",{sessionId,prompt:[{type:"text",text:input}]});
    if (runtime.harness && answer.messageId && !answer.stopReason) {
      answer = await Promise.race([terminal.promise, new Promise((_, reject) => {
        terminalTimer = setTimeout(() => reject(new Error(`${label} 已创建会话，但等待模型终态超时。`)), requestTimeout);
      })]);
    }
    collecting=false;
    if(answer.stopReason!=="end_turn"||!text.trim())throw new Error(runtime.harness
      ? `${label} 已创建原生会话，但模型未返回可用回复，请检查 WorkBuddy 提供的模型和登录状态。`
      : `${label} 未完成原生任务。`);
    if (runtime.harness && !availableMode) throw new Error(`${label} 模型已回复，但当前入口缺少安全的角色权限模式。`);
    await session.save(sessionId);
    return text;
  }finally{
    clearTimeout(terminalTimer);
    collecting=false;
    if(sessionId)rpc.notify("session/cancel",{sessionId});
    rpc.close();
  }
}
