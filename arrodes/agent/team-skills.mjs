import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export const MAX_SKILL_BYTES = 32 * 1024;

export function validateSkillIds(ids, available) {
  if (!Array.isArray(ids) || ids.length > 6 || new Set(ids).size !== ids.length ||
      ids.some((id) => !available.has(id))) throw new Error("每个 Agent 最多选择 6 个不同的可用 Skill。");
  if (ids.reduce((sum, id) => sum + Buffer.byteLength(available.get(id).instructions), 0) > 64 * 1024) {
    throw new Error("单个 Agent 的 Skill 正文合计不能超过 64 KB。");
  }
  return ids;
}
export const TEAM_COORDINATION_SKILL = {
  id: "builtin-team-coordination",
  name: "团队协调",
  description: "澄清目标，检查输入与角色权限，定义交付及验收。",
  instructions: [
    "先区分对话、咨询与可执行任务。目标、关键数据或必需能力缺失时先说明缺口，等用户补齐。",
    "以工作区清单为线索，不假设文件已存在。每项任务明确负责人、必需的现有输入、交付物和可检查的验收条件；上游将生成的内容通过依赖交接。",
    "只分派给现有且有权限的角色。只读角色负责调查与核对，落盘交付须由读写角色负责。",
    "汇总时区分已核验的产物、缺口和待验证事项，不声称未发生的执行或验收。",
  ].join("\n"),
};

const builtIn = [
  TEAM_COORDINATION_SKILL,
  {
    id: "builtin-evidence", name: "资料核对", description: "提取可追溯的依据，区分观察和推断。",
    instructions: "先列出可用材料，只读与目标有关的内容。每个关键结论给出具体文件名及可定位的依据。区分已核实事实、推断和缺失信息。把证据摘要作为交接材料。",
  },
  {
    id: "builtin-code", name: "代码交付", description: "检查现有代码，做小改动并验证。",
    instructions: "先读取相关文件与交接材料，再做解决目标所需的最小改动。运行现有工具支持的检查，交付改动文件、检查结果和未解决的问题。不要声称跑过无法使用的检查。",
  },
  {
    id: "builtin-data", name: "表格核对", description: "检查字段、异常行和汇总口径。",
    instructions: "读取相关表格文本，先检查表头、单位、空值、重复项与样本范围，再做目标要求的汇总。交付统计口径、异常依据和可复查的结果，明确只检查了哪些数据。",
  },
  {
    id: "builtin-acceptance", name: "交付验收", description: "按实际要求和证据验收。",
    instructions: "逐项核对用户要求、收到的交付和实际检查结果。证据不足时明确指出缺口。只有要求与证据对应时才通过。",
  },
];

function readMarkdownFile(path) {
  if (extname(path).toLowerCase() !== ".md") throw new Error("请选择 Markdown Skill 文件。");
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    const size = readSync(handle, buffer);
    return buffer.subarray(0, size);
  } finally {
    closeSync(handle);
  }
}

function readInstructions(bytes, path) {
  if (bytes.length > MAX_SKILL_BYTES) throw new Error("Skill 文件不能超过 32 KB。");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("请将 Skill 文件保存为 UTF-8。"); }
  text = text.replace(/\r\n/g, "\n").trim();
  const header = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (text.startsWith("---\n") && !header) throw new Error("Skill 的头部没有结束，请检查 SKILL.md。");
  const field = (key) => header?.[1].match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"))?.[1]
    .trim().replace(/^(["'])(.*)\1$/, "$2");
  const filename = basename(path, extname(path));
  const name = (field("name") || (filename.toLowerCase() === "skill" ? basename(dirname(path)) : filename)).slice(0, 64);
  const instructions = text.slice(header?.[0].length ?? 0).trim();
  if (!name || !instructions) throw new Error("Skill 需要名称和非空的操作说明。");
  const description = (field("description") || "").slice(0, 1024);
  const id = `local-${createHash("sha256").update(JSON.stringify([name, description, instructions])).digest("hex")}`;
  return { id, name, description, instructions };
}

export function createTeamSkillStore(dataDir) {
  const file = join(dataDir, "team-skills.json");
  function list() {
    let imported;
    try {
      imported = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [...builtIn];
      throw error;
    }
    if (!Array.isArray(imported) || imported.some((skill) => !skill ||
      !/^local-[0-9a-f]{64}$/.test(skill.id) || typeof skill.name !== "string" ||
      typeof skill.description !== "string" || typeof skill.instructions !== "string")) {
      throw new Error("无法读取 Skill 库。");
    }
    return [...builtIn, ...imported];
  }
  function importMarkdown(bytes, path) {
    const skill = readInstructions(bytes, path);
    const current = list();
    if (current.some(({ id }) => id === skill.id)) return skill.id;
    const imported = current.filter(({ id }) => id.startsWith("local-"));
    imported.push(skill);
    mkdirSync(dataDir, { recursive: true });
    const pending = `${file}.${randomUUID()}.tmp`;
    writeFileSync(pending, JSON.stringify(imported, null, 2), "utf8");
    renameSync(pending, file);
    return skill.id;
  }
  return {
    list,
    catalog: () => list().map(({ id, name, description }) => ({ id, name, description })),
    importFile: (path) => importMarkdown(readMarkdownFile(path), path),
    importMarkdown,
  };
}

export function skillInstructions(skills) {
  if (!skills.length) return "";
  return "\n本角色已配置以下 Skill。按相关说明完成任务，角色目标和既有工具权限始终有效。\n" +
    skills.map(({ name, instructions }) => `### Skill：${name}\n${instructions}`).join("\n\n");
}
