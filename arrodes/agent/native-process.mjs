import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute, relative, resolve } from "node:path";
import { safePath } from "./loop.mjs";

export const eventPrefix = "ARRODES_NATIVE_EVENT ";

// Native tools remain registered. Decisions apply to each actual call after native hooks.
export async function nativeToolPermission({ name, args = {}, workspaceDir, writing, approveAction, label }) {
  const originalName=name;
  name=({Read:"read",Write:"write",Edit:"edit",MultiEdit:"edit",Glob:"search_files",Grep:"search_files",LS:"search_files",Skill:"skill_view"})[name]??name;
  const reads = ["read_file", "search_files", "read"];
  const writes = ["write_file", "patch", "write", "edit", "apply_patch"];
  if (reads.includes(name) || writes.includes(name)) {
    if (writes.includes(name) && !writing) return false;
    const paths = [];
    if (args.path || args.file_path) paths.push(args.path || args.file_path);
    if (name === "search_files" && !args.path) paths.push(".");
    const patch = args.patch || args.input;
    if (["patch", "apply_patch"].includes(name) && typeof patch === "string") {
      for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1].trim());
      for (const match of patch.matchAll(/^\*\*\* Move File: (.+?)\s*->\s*(.+)$/gm)) paths.push(match[1].trim(), match[2].trim());
      for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1].trim());
    }
    if (!paths.length || paths.some((path) => typeof path !== "string" || !path)) return false;
    try {
      for (const path of paths) {
        const rel = relative(workspaceDir, isAbsolute(path) ? path : resolve(workspaceDir, path));
        if (!rel && reads.includes(name)) continue;
        safePath(workspaceDir, rel);
      }
      return true;
    } catch { return false; }
  }
  if (["skills_list", "skill_view", "memory", "session_search", "todo", "web_search", "web_extract", "tool_search"].includes(name)) return true;
  // Shell, code execution, browser actions and unknown MCP/plugin tools cannot be
  // inferred read-only from their names. Request the exact operation, never a blanket grant.
  return Boolean(await approveAction?.({
    action: `${label} 请求使用原生工具：${originalName}`,
    detail: `工作区：${workspaceDir}\n角色权限：${writing ? "读写" : "只读"}\n此工具可能执行命令或访问工作区之外的资源，仅授权本次操作。\n${JSON.stringify(args, null, 2)}`,
    risk: "sensitive",
  }));
}

export function runNativeProcess(exe, args, { cwd, env, request, workspaceDir, writing, approveAction, onProgress, label }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let final, failure, pending = Promise.resolve(), bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.kill();
      error ? reject(error) : resolvePromise(final);
    };
    const timer = setTimeout(() => finish(new Error(`${label} 执行超时。`)), 240_000);
    const lines = createInterface({ input: child.stdout });
    child.stderr.on("data", (data) => {
      // Relay only a known diagnostic, never native logs or credentials.
      if (label === "OpenClaw" && data.toString().includes("AUTH_PROFILE_MIGRATION_REQUIRED"))
        failure = new Error("OpenClaw 的本机凭据库需要迁移，请先运行 openclaw doctor --fix。");
    });
    child.on("error", () => finish(new Error(`${label} 无法启动，请检查本机安装。`)));
    child.stdin.on("error", () => {});
    lines.on("line", (line) => {
      bytes += Buffer.byteLength(line);
      if (bytes > 2 * 1024 * 1024) return finish(new Error(`${label} 输出超过限制。`));
      if (!line.startsWith(eventPrefix)) return;
      let event;
      try { event = JSON.parse(line.slice(eventPrefix.length)); } catch { return; }
      if (event.type === "result") final = event.text;
      if (event.type === "error") failure ??= new Error(`${label} 未完成任务${/^[A-Za-z]+(?:Error|Exception)$/.test(event.code) ? `（${event.code}）` : ""}，请检查它自己的模型配置、依赖与连接。`);
      if (event.type === "tool") {
        onProgress?.(`${label} · ${event.name}`);
        pending = pending.then(async () => {
          let allowed = false;
          try { allowed = await nativeToolPermission({ ...event, workspaceDir, writing, approveAction, label }); } catch {}
          if (!settled && child.stdin.writable) child.stdin.write(JSON.stringify({ id: event.id, allowed }) + "\n");
        });
      }
    });
    child.on("close", async (code) => {
      await pending;
      finish(failure ?? (code !== 0 || typeof final !== "string" || !final.trim()
        ? new Error(`${label} 未完成任务，请检查它自己的模型配置、依赖与连接。`) : undefined));
    });
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}
