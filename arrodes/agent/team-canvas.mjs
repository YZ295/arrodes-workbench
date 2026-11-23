import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowsRoleAccess, executorLabel, supportedExecutors } from "./external-executors.mjs";
import { validateSkillIds } from "./team-skills.mjs";

const required = ["coordinator", "reviewer"];

export function validateCanvas(input, roles, skills = []) {
  const legacy = input?.coordinatorExecutor;
  const executors = input?.roleExecutors ?? (legacy ? { coordinator: legacy } : {});
  const knownRoles = new Map(roles.map((role) => [role.id, role]));
  if (typeof executors !== "object" || Array.isArray(executors) ||
      Object.entries(executors).some(([id, executor]) => !knownRoles.has(id) || !supportedExecutors.includes(executor))) {
    throw new Error("角色执行器配置无效。");
  }
  for (const [id, executor] of Object.entries(executors)) {
    if (!allowsRoleAccess(executor, knownRoles.get(id).access)) throw new Error(`${executorLabel(executor)} 当前仅支持只读角色。`);
  }
  const roleSettings = {};
  if (input.roleSettings !== undefined && (!input.roleSettings || typeof input.roleSettings !== "object" || Array.isArray(input.roleSettings))) {
    throw new Error("角色设置格式无效。");
  }
  for (const [id, settings] of Object.entries(input.roleSettings ?? {})) {
    if (!knownRoles.has(id) || !settings || typeof settings !== "object" ||
      typeof (settings.instructions ?? "") !== "string" || (settings.instructions ?? "").length > 6000 ||
      typeof (settings.modelId ?? "") !== "string" || (settings.modelId ?? "").length > 150 ||
      !["ephemeral", "persistent"].includes(settings.memory ?? "ephemeral")) throw new Error("角色设置无效。");
    const executor = executors[id] ?? knownRoles.get(id).executor ?? "builtin";
    if (settings.memory === "persistent" && executor === "builtin") throw new Error("内置角色不使用外部 Agent 的原生会话。");
    roleSettings[id] = { instructions: (settings.instructions ?? "").trim(),
      modelId: (settings.modelId ?? "").trim(), memory: settings.memory ?? "ephemeral" };
  }
  const roleExecutors = Object.fromEntries(Object.entries(executors));
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
  return { nodes, edges, configured: input.configured === true,
    ...(Object.keys(roleExecutors).length ? { roleExecutors } : {}),
    ...(Object.keys(roleSettings).length ? { roleSettings } : {}) };
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

// 条件语义：连线只在两端角色都实际参与本计划时生效（作为交接顺序），与任务无关的连线自动忽略。
export function applyCanvasDependencies(tasks, edges) {
  const byRole = Map.groupBy(tasks, ({ role }) => role);
  return tasks.map((task) => {
    const dependsOn = new Set(task.dependsOn);
    for (const { from, to } of edges) {
      if (task.role !== to || from === "coordinator") continue;
      const upstream = byRole.get(from);
      if (!upstream?.length) continue;
      for (const { id } of upstream) dependsOn.add(id);
    }
    return { ...task, dependsOn: [...dependsOn] };
  });
}
