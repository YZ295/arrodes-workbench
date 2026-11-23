import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeToolPermission, runNativeProcess } from "../agent/native-process.mjs";

test("原生文件工具遵守角色权限及工作区边界", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arrodes-native-permission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir);
  const permit = (name, args, writing = false) => nativeToolPermission({ name, args, writing, workspaceDir });
  assert.equal(await permit("read_file", { path: "source.txt" }), true);
  assert.equal(await permit("write_file", { path: "output.txt" }), false);
  assert.equal(await permit("write_file", { path: "output.txt" }, true), true);
  assert.equal(await permit("write_file", { path: join(root, "escape.txt") }, true), false);
  assert.equal(await permit("read_file", { path: "../secret.txt" }), false);
  assert.equal(await permit("search_files", { pattern: "foo" }), true);
  assert.equal(await permit("patch", { patch: "*** Update File: safe.txt\n*** Add File: ../escape.txt" }, true), false);
  assert.equal(await permit("patch", { mode: "v4a", patch: "*** Update File: safe.txt" }, true), true);
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(workspaceDir, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await permit("write_file", { path: "link/escape.txt" }, true), false);
});

test("原生执行失败保留已识别的修复原因，不泄露底层日志", async () => {
  const script = `process.stdin.once('data',()=>{process.stderr.write('AUTH_PROFILE_MIGRATION_REQUIRED private-test-token');setTimeout(()=>{console.log('ARRODES_NATIVE_EVENT '+JSON.stringify({type:'error'}));process.exit(1)},30)});`;
  await assert.rejects(runNativeProcess(process.execPath,["-e",script],{cwd:process.cwd(),env:process.env,request:{},label:"OpenClaw"}),
    (error) => /openclaw doctor --fix/.test(error.message) && !error.message.includes("private-test-token"));
});

test("原生工具授权取消后给后端返回拒绝，仍可正常汇总", async () => {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});let first=true;rl.on('line',line=>{if(first){first=false;console.log('ARRODES_NATIVE_EVENT '+JSON.stringify({type:'tool',id:7,name:'terminal',args:{command:'echo test'}}));}else{const decision=JSON.parse(line);console.log('ARRODES_NATIVE_EVENT '+JSON.stringify({type:'result',text:decision.allowed?'unexpected grant':'permission denied'}));process.exit(0)}});`;
  const result=await runNativeProcess(process.execPath,["-e",script],{cwd:process.cwd(),env:process.env,request:{},label:"Hermes",workspaceDir:process.cwd(),approveAction:async()=>false});
  assert.equal(result,"permission denied");
});

test("原生 Skill、记忆及检索保留；命令和未知插件必须逐次授权", async () => {
  const workspaceDir = process.cwd();
  for (const name of ["skills_list", "skill_view", "memory", "session_search", "web_search"])
    assert.equal(await nativeToolPermission({ name, workspaceDir }), true);
  for (const name of ["terminal", "execute_code", "delegate_task", "mcp_custom", "browser_click"]) {
    assert.equal(await nativeToolPermission({ name, workspaceDir, writing: true }), false);
    let approvals = 0;
    assert.equal(await nativeToolPermission({ name, args: { command: "actual-command" }, workspaceDir, label: "Hermes",
      approveAction: async ({ detail }) => { approvals++; assert.match(detail, /actual-command/); return true; } }), true);
    assert.equal(approvals, 1);
  }
});
