import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function nativeSession(executor, context) {
  if (context.settings?.memory !== "persistent") return { id: undefined, save: async () => {} };
  if (!context.stateRoot || !context.workspaceDir || !context.roleId) throw new Error("延续原生会话需要工作区、角色和存储目录。");
  const key = createHash("sha256").update(JSON.stringify([context.workspaceDir, context.roleId])).digest("hex");
  const file = join(context.stateRoot, `${executor}-native`, `${key}.json`);
  let id;
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    id = saved.session_id;
    if (typeof id !== "string" || !id || id.length > 300 || /[\r\n\0]/.test(id)) throw new Error("invalid session id");
  } catch (error) { if (error.code !== "ENOENT") throw new Error("原生会话记录无效，请为该角色新建会话。"); }
  return { id, file, save: async (sessionId) => {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 300 || /[\r\n\0]/.test(sessionId)) throw new Error("智能体未返回有效的原生会话编号。");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ session_id: sessionId }), "utf8");
  } };
}
