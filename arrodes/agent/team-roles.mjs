import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function validRole(role) {
  return role && typeof role.name === "string" && role.name.trim() && role.name.length <= 40 &&
    !/[\u0000-\u001f]/.test(role.name) && typeof role.description === "string" &&
    role.description.trim() && role.description.length <= 1200 && ["read", "write"].includes(role.access);
}

export function createTeamRoleStore(dataDir) {
  const file = join(dataDir, "team-roles.json");

  function list() {
    let saved;
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (!Array.isArray(saved) || !saved.every((role) => validRole(role) &&
      typeof role.id === "string" && /^role-[a-f0-9-]{36}$/.test(role.id))) {
      throw new Error("角色配置无法读取。");
    }
    return saved;
  }

  function create(input, reservedNames, skillIds = []) {
    const candidate = {
      name: typeof input?.name === "string" ? input.name.trim() : "",
      description: typeof input?.description === "string" ? input.description.trim() : "",
      access: input?.access,
      skillIds,
    };
    if (!validRole(candidate)) return { ok: false, error: "请填写角色名称和职责，并选择工具权限。" };
    const saved = list();
    const nameKey = (name) => name.normalize("NFKC").toLowerCase();
    const names = [...reservedNames, ...saved.map(({ name }) => name)];
    if (names.some((name) => nameKey(name) === nameKey(candidate.name))) {
      return { ok: false, error: "已有同名角色，请换一个名称。" };
    }
    saved.push({ id: `role-${randomUUID()}`, ...candidate });
    mkdirSync(dataDir, { recursive: true });
    const pending = `${file}.${randomUUID()}.tmp`;
    writeFileSync(pending, JSON.stringify(saved, null, 2), "utf8");
    renameSync(pending, file);
    return { ok: true, roles: saved };
  }

  return { list, create };
}
