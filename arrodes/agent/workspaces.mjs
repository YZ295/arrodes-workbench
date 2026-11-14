import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, parse, resolve } from "node:path";

function pathKey(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function existingDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("请选择一个文件夹。");
  const directory = realpathSync(path);
  if (!lstatSync(directory).isDirectory()) throw new Error("请选择一个文件夹。");
  return directory;
}

export function createWorkspaceStore(dataDir) {
  const managedRoot = join(dataDir, "workspaces");
  const registry = join(dataDir, "external-workspaces.json");

  function readRegistry() {
    let saved;
    try {
      saved = JSON.parse(readFileSync(registry, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (!Array.isArray(saved) || !saved.every((entry) => entry &&
      typeof entry.id === "string" && /^folder:[a-f0-9-]{36}$/.test(entry.id) &&
      typeof entry.name === "string" && entry.name && typeof entry.path === "string" && isAbsolute(entry.path))) {
      throw new Error("工作区位置记录无法读取。");
    }
    return saved;
  }

  function list() {
    mkdirSync(managedRoot, { recursive: true });
    const managed = readdirSync(managedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => ({ id: name, name, path: join(managedRoot, name), available: true }));
    const external = readRegistry().map((entry) => {
      let available = false;
      try {
        available = pathKey(existingDirectory(entry.path)) === pathKey(entry.path);
      } catch {
        // Keep the project and its conversations when the drive is unavailable.
      }
      return { ...entry, available };
    });
    return [...managed, ...external];
  }

  function attach(path) {
    const directory = existingDirectory(path);
    const existing = list().find((workspace) => pathKey(workspace.path) === pathKey(directory));
    if (existing) return existing;

    const entry = {
      id: `folder:${randomUUID()}`,
      name: basename(directory) || parse(directory).root,
      path: directory,
    };
    const pending = `${registry}.${randomUUID()}.tmp`;
    writeFileSync(pending, JSON.stringify([...readRegistry(), entry], null, 2), "utf8");
    renameSync(pending, registry);
    return { ...entry, available: true };
  }

  function create(name, location = null) {
    const safe = String(name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 40);
    if (!safe || safe.endsWith(".") || safe !== safe.trim()) throw new Error("请输入有效的工作区名称。");
    if (!location) {
      mkdirSync(managedRoot, { recursive: true });
      const path = join(managedRoot, safe);
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing && !existing.isDirectory()) throw new Error("这个工作区不可用。");
      if (!existing) mkdirSync(path);
      const name = basename(existingDirectory(path));
      return { id: name, name, path, available: true };
    }

    if (pathKey(existingDirectory(location)) !== pathKey(location)) throw new Error("请重新选择工作区位置。");
    const path = join(location, safe);
    mkdirSync(path);
    try {
      return attach(path);
    } catch (error) {
      try { rmdirSync(path); } catch { /* A non-empty folder must stay intact. */ }
      throw error;
    }
  }

  return { list, get: (id) => list().find((workspace) => workspace.id === id), create, attach };
}
