import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSkillIds } from "./team-skills.mjs";

const required = ["coordinator", "reviewer"];

export function validateCanvas(input, roles, skills = []) {
  const workers = new Set(roles.filter(({ access }) => access).map(({ id }) => id));
  const available = new Map(skills.map((skill) => [skill.id, skill]));
  if (!Array.isArray(input?.nodes) || !Array.isArray(input.edges) ||
      input.nodes.length > 26 || input.edges.length > 100) throw new Error("画布配置无效。");
  const ids = new Set();
  const nodes = input.nodes.map((entry) => {
    const { id, x, y, skillIds = [] } = entry ?? {};
    if ((!workers.has(id) && !required.includes(id)) || ids.has(id) ||
        ![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error("画布包含重复、未知或位置无效的 Agent。");
    }
    validateSkillIds(skillIds, available);
    ids.add(id);
    return { id, x, y, skillIds };
  });
  if (required.some((id) => !ids.has(id))) throw new Error("画布需要保留协调者和验收 Agent。");

  const parents = new Map(nodes.map(({ id }) => [id, new Set()]));
  const edges = input.edges.map((entry) => {
    const { from, to } = entry ?? {};
    if (!ids.has(from) || !ids.has(to) || from === to ||
        !(workers.has(from) && (workers.has(to) || to === "reviewer") || from === "coordinator" && workers.has(to))) {
      throw new Error("协调者负责分派，验收 Agent 接收交付。请选择有效的发送方和接收方。");
    }
    if (parents.get(to).has(from)) throw new Error("这条连接已经存在。");
    parents.get(to).add(from);
    return { from, to };
  });
  const active = new Set();
  const checked = new Set();
  function check(id) {
    if (active.has(id)) throw new Error("这条连线会形成环，请调整交接方向。");
    if (checked.has(id)) return;
    active.add(id);
    for (const from of parents.get(id)) check(from);
    active.delete(id);
    checked.add(id);
  }
  for (const id of ids) check(id);
  if (edges.length && input.configured !== true) throw new Error("带连线的画布必须启用画布分工。");
  return { nodes, edges, configured: input.configured === true };
}

export function createTeamCanvasStore(dataDir) {
  const file = join(dataDir, "team-canvases.json");
  function list() {
    try {
      return Object.assign(Object.create(null), JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return Object.create(null);
      throw error;
    }
  }
  return {
    get: (workspaceId) => list()[workspaceId] ?? null,
    save(workspaceId, input, roles, skills) {
      const graph = validateCanvas(input, roles, skills);
      const saved = list();
      saved[workspaceId] = graph;
      mkdirSync(dataDir, { recursive: true });
      const pending = `${file}.${randomUUID()}.tmp`;
      writeFileSync(pending, JSON.stringify(saved, null, 2), "utf8");
      renameSync(pending, file);
      return graph;
    },
  };
}

export function applyCanvasDependencies(tasks, edges) {
  return tasks.map((task) => {
    const dependsOn = new Set(task.dependsOn);
    for (const { from, to } of edges) {
      if (task.role !== to || from === "coordinator") continue;
      const upstream = tasks.filter(({ role }) => role === from);
      if (!upstream.length) throw new Error("分工缺少画布连线要求的上游 Agent，请重试。");
      for (const { id } of upstream) dependsOn.add(id);
    }
    return { ...task, dependsOn: [...dependsOn] };
  });
}
