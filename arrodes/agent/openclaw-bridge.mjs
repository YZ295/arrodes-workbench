// Launch the installed OpenClaw CLI with its resolved config and a native tool hook.
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const writeTransport = process.stdout.write.bind(process.stdout);
const emit = (event) => writeTransport("ARRODES_NATIVE_EVENT " + JSON.stringify(event) + "\n");
const lines = createInterface({ input: process.stdin });
const request = await new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line))));
const pending = new Map();
let nextId = 0;
let delegate;
lines.on("line", (line) => {
  if(delegate){if(delegate.stdin.writable)delegate.stdin.write(line+"\n");return;}
  try { const answer = JSON.parse(line); pending.get(answer.id)?.(answer.allowed === true); } catch {}
});
// CLI completion must be able to exit while stdin remains available for permissions.
process.stdin.unref?.();
globalThis[Symbol.for("arrodes.native.permission")] = async (name, args) => {
  const id = ++nextId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); }, 180_000);
    pending.set(id, (allowed) => { clearTimeout(timer); pending.delete(id); resolve(allowed); });
    emit({ type: "tool", id, name, args });
  });
};
try {
  const cli = process.argv[2];
  const root = dirname(cli);
  const { captureRuntimeConfigAsyncReader, setRuntimeConfigSnapshot } = await import(pathToFileURL(join(root, "dist", "plugin-sdk", "runtime-config-snapshot.js")));
  const config = await captureRuntimeConfigAsyncReader()();
  const plugin = join(request.directory, "permission-bridge");
  await mkdir(plugin,{recursive:true});
  await writeFile(join(plugin, "openclaw.plugin.json"), JSON.stringify({
    id: "arrodes-permission-bridge", name: "Arrodes permissions", configSchema: { type: "object", additionalProperties: false, properties: {} },
  }));
  await writeFile(join(plugin, "index.mjs"), `export default {id:"arrodes-permission-bridge",name:"Arrodes permissions",register(api){
    const gate=globalThis[Symbol.for("arrodes.native.permission")];
    if(!gate)throw new Error("Arrodes permission transport missing");
    api.on("before_tool_call",async(event)=>{try {
      return await gate(event.toolName,event.params??{}) ? {} : {block:true,blockReason:"Arrodes role permission or user approval denied this tool call."};
    }catch{return {block:true,blockReason:"Arrodes permission transport unavailable."};}},{priority:-100000});
  }};`);
  if (config.plugins?.enabled === false) throw new Error("Native plugins disabled");
  config.plugins = { ...config.plugins,
    load: { ...config.plugins?.load, paths: [...new Set([...(config.plugins?.load?.paths ?? []), plugin])] },
    ...(Array.isArray(config.plugins?.allow) ? { allow: [...config.plugins.allow, "arrodes-permission-bridge"] } : {}),
    entries: { ...config.plugins?.entries, "arrodes-permission-bridge": { enabled: true, hooks: { allowConversationAccess: true } } },
  };
  // Native file tools enforce their own workspace boundary in addition to our hook.
  config.tools = { ...config.tools, fs: { ...config.tools?.fs, workspaceOnly: true } };
  config.agents={...config.agents,defaults:{...config.agents?.defaults,workspace:request.cwd}};
  if(config.agents.entries)config.agents.entries=Object.fromEntries(Object.entries(config.agents.entries).map(([id,entry])=>[id,{...entry,workspace:request.cwd}]));
  const cfg = join(request.directory, "openclaw-native.json");
  const message = join(request.directory, "message.txt");
  await writeFile(cfg, JSON.stringify(config));
  await writeFile(message, request.prompt);
  if(!request.prepared){
    // The native local entry captures its config path at module startup. Load
    // the untouched native profile first, then enter a fresh process with our
    // per-run overlay so the native session and permission hook both use it.
    delegate=spawn(process.execPath,[fileURLToPath(import.meta.url),cli],{cwd:process.cwd(),env:{...process.env,OPENCLAW_CONFIG_PATH:cfg},windowsHide:true,stdio:["pipe","pipe","pipe"]});
    delegate.stdin.on("error",()=>{});
    delegate.stdout.pipe(process.stdout);delegate.stderr.pipe(process.stderr);
    const cleanup=()=>delegate.kill();process.once("exit",cleanup);
    delegate.stdin.write(JSON.stringify({...request,prepared:true})+"\n");
    process.exitCode=await new Promise(resolve=>{delegate.once("error",()=>resolve(1));delegate.once("close",code=>resolve(code??1));});
    process.removeListener("exit",cleanup);lines.close();process.stdin.destroy();
  }else{
  let stdout = "";
  const sessionId=request.sessionId??randomUUID();
  process.stdout.write = (chunk, encoding, callback) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    try {
      const result = JSON.parse(stdout);
      const text=result.final??result.payloads?.map(p=>p.text??"").join("\n");
      const completed=result.ok===true||Array.isArray(result.payloads)&&!result.meta?.error&&!result.meta?.aborted&&!result.payloads.some(p=>p.isError);
      if (completed && text?.trim()) {
        if(request.sessionFile){mkdirSync(dirname(request.sessionFile),{recursive:true});writeFileSync(request.sessionFile,JSON.stringify({session_id:sessionId}));}
        emit({ type: "result", text });
      }
      else if (result.ok === false) emit({ type: "error" });
    } catch {}
    (typeof encoding === "function" ? encoding : callback)?.();
    return true;
  };
  // Import while argv still identifies our bridge, so the CLI's main-module
  // wrapper does not spawn a supervisor. This exported entry runs one native CLI command.
  const { runMainOrRootHelp } = await import(pathToFileURL(join(root, "dist", "entry.js")));
  // New conversation and durable memory are independent: never replace the
  // operator's native state directory just because resume is unchecked.
  process.argv = [process.execPath,cli,"agent","--local","--session-id",sessionId,"--message-file",message,"--json","--timeout","180",
    ...(request.model?["--model",request.model]:[])];
  setRuntimeConfigSnapshot(config);
  await runMainOrRootHelp(process.argv);
  }
} catch {
  emit({ type: "error" });
  process.exitCode = 1;
  lines.close();
  process.stdin.destroy();
}
