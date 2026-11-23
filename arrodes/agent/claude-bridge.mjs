import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
const output = process.stdout.write.bind(process.stdout);
const emit = (event) => output("ARRODES_NATIVE_EVENT " + JSON.stringify(event) + "\n");
const lines = createInterface({ input: process.stdin });
const request = await new Promise(resolve => lines.once("line", line => resolve(JSON.parse(line))));
const pending = new Map();
const granted = new Map();
let nextId = 0;
lines.on("line", line => {
  try { const result = JSON.parse(line); pending.get(result.id)?.(result.allowed === true); } catch {}
});
const authorize = async (name, args, toolId) => {
  if (toolId && granted.has(toolId)) return granted.get(toolId);
  const id = ++nextId;
  const allowed = await new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); }, 180_000);
    pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); });
    emit({ type: "tool", id, name, args });
  });
  if (toolId) granted.set(toolId, allowed);
  return allowed;
};
try {
  const { query } = await import(pathToFileURL(request.sdk));
  let final, sessionId;
  for await (const message of query({ prompt: request.prompt, options: {
    cwd: request.cwd, settingSources: ["user", "project", "local"],
    pathToClaudeCodeExecutable: request.executable,
    ...(request.model ? { model: request.model } : {}),
    ...(request.resume ? { resume: request.resume } : {}),
    permissionMode: "default",
    hooks: { PreToolUse: [{ hooks: [async input => {
      const allowed = await authorize(input.tool_name, input.tool_input, input.tool_use_id);
      // Add role restrictions, then let Claude apply its own deny/ask/allow
      // rules. A blanket hook "allow" would override a user's native deny.
      return allowed ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: "Arrodes role permission or user approval denied this call" } };
    }] }] },
    canUseTool: async (name, input, context) => await authorize(name, input, context.toolUseID)
      ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Arrodes permission denied" },
  } })) {
    if (message.session_id) sessionId = message.session_id;
    if (message.type === "result") {
      if (message.is_error || message.subtype !== "success") throw new Error("Native task failed");
      final = message.result;
    }
  }
  if (!final?.trim()) throw new Error("No final response");
  if (request.sessionFile) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    if (!sessionId) throw new Error("No native session id");
    await mkdir(dirname(request.sessionFile), { recursive: true });
    await writeFile(request.sessionFile, JSON.stringify({ session_id: sessionId }));
  }
  emit({ type: "result", text: final });
} catch {
  emit({ type: "error" });
  process.exitCode = 1;
} finally {
  lines.close(); process.stdin.destroy();
}
