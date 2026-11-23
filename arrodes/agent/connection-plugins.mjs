import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function createConnectionPluginStore(dataDir) {
  const file = join(dataDir, "connection-plugins.json");

  function list() {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  function save(id, { enabled, executable = "", verifiedAt = null }) {
    if (typeof enabled !== "boolean" || typeof executable !== "string" ||
        (executable && (id !== "codex" || !isAbsolute(executable) || executable.length > 1024))) {
      throw new Error("请选择 Codex CLI 的本机绝对路径，或留空使用自动检测。");
    }
    const entry = { enabled, executable, verifiedAt };
    mkdirSync(dataDir, { recursive: true });
    const pending = `${file}.${randomUUID()}.tmp`;
    writeFileSync(pending, JSON.stringify({ ...list(), [id]: entry }, null, 2), "utf8");
    renameSync(pending, file);
    return entry;
  }

  return { list, save };
}
