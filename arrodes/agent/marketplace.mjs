import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchGithubSkill } from "./github-skills.mjs";

const indexUrl = "https://raw.githubusercontent.com/YZ295/arrodes-workbench/refs/heads/codex/plugin-repository/arrodes/agent/marketplace/catalog.json";
const bundled = JSON.parse(readFileSync(new URL("./marketplace/catalog.json", import.meta.url), "utf8"))
  .filter(({ distribution }) => distribution !== "remote");
const fields = { id: 64, kind: 12, category: 40, name: 64, description: 280, author: 64, version: 30 };
const limit = 96 * 1024;
export const defaultWindowColors = { color: "#ffffff", symbolColor: "#172033" };
const nightWindowColors = { color: "#111b2e", symbolColor: "#edf3fc" };
const versionPattern = /^(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})$/;

function newer(candidate, installed) {
  if (!versionPattern.test(candidate) || !versionPattern.test(installed)) return false;
  const numbers = installed.split(".").map(Number);
  const difference = candidate.split(".").map((part, index) => Number(part) - numbers[index]).find(Boolean);
  return difference > 0;
}

function readEntry(value) {
  if (!value || Object.entries(fields).some(([field, max]) =>
    typeof value[field] !== "string" || !value[field].trim() || value[field].length > max)) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.id) || value.kind !== "skill" || !versionPattern.test(value.version)) return null;
  let url;
  try { url = new URL(value.source); } catch { return null; }
  if (url.origin !== "https://github.com" || url.username || url.password ||
    !/^\/[^/]+\/[^/]+\/blob\/.+\/SKILL\.md$/.test(url.pathname)) return null;
  return { ...Object.fromEntries(Object.keys(fields).map((field) => [field, value[field]])), source: url.href };
}

export function createMarketplace({ dataDir, teamSkills, fetcher, checkIdle, checkSkillUnused }) {
  const file = join(dataDir, "marketplace.json");
  const catalog = new Map(bundled.map((entry) => [entry.id, entry]));
  const bundledById = new Map(catalog);
  let changing = false;
  let source = "随应用提供";

  function load() {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return { installed: {}, theme: null };
      throw error;
    }
  }

  function save(state) {
    mkdirSync(dataDir, { recursive: true });
    const pending = `${file}.${randomUUID()}.tmp`;
    writeFileSync(pending, JSON.stringify(state, null, 2), "utf8");
    renameSync(pending, file);
  }

  function snapshot() {
    const { installed, theme } = load();
    const windowColors = theme === "night" ? nightWindowColors : defaultWindowColors;
    const updates = [...catalog.values()].filter((entry) => Object.hasOwn(installed, entry.id) &&
      newer(entry.version, installed[entry.id].version)).map(({ id }) => id);
    return { catalog: [...catalog.values()], installed, theme, source, windowColors, updates };
  }

  async function refresh() {
    try {
      const response = await fetcher(indexUrl, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error("目录暂不可用");
      const body = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) throw new Error("目录过大");
        body.push(chunk);
      }
      const entries = JSON.parse(Buffer.concat(body).toString("utf8"));
      if (!Array.isArray(entries)) throw new Error("目录格式无效");
      catalog.clear();
      for (const entry of bundled) catalog.set(entry.id, entry);
      for (const entry of entries.map(readEntry).filter(Boolean)) {
        const existing = catalog.get(entry.id);
        if (!existing || (existing.kind === entry.kind && newer(entry.version, existing.version))) catalog.set(entry.id, entry);
      }
      source = "GitHub 社区目录";
    } catch {
      source = "社区目录暂不可用 · 当前可浏览本机目录";
    }
    return snapshot();
  }

  async function install(id, updating = false) {
    checkIdle();
    if (changing) throw new Error("请等待当前插件操作完成。");
    const entry = catalog.get(id);
    if (!entry) throw new Error("此插件已离开目录，请刷新后重试。");
    const installed = load().installed;
    const previous = Object.hasOwn(installed, id) ? installed[id] : null;
    if (previous && (!updating || !newer(entry.version, previous.version))) return snapshot();
    if (updating && !previous) throw new Error("请先安装插件。");
    changing = true;
    try {
      let skillId;
      if (entry.kind === "skill") {
        const key = previous?.skillId ?? `local-${createHash("sha256").update(`marketplace:${id}`).digest("hex")}`;
        if (bundledById.get(id) === entry) {
          const path = new URL(`./skills/${id}/SKILL.md`, import.meta.url);
          skillId = teamSkills.importMarkdown(readFileSync(path), path.pathname, "", key);
        } else {
          const item = await fetchGithubSkill(entry.source, fetcher);
          checkIdle();
          skillId = teamSkills.importMarkdown(item.bytes, item.path, "", key);
        }
      }
      const state = load();
      state.installed[id] = { ...entry, ...(skillId ? { skillId } : {}) };
      save(state);
      return snapshot();
    } finally {
      changing = false;
    }
  }

  function remove(id, unlink = false) {
    checkIdle();
    if (changing) throw new Error("请等待当前插件操作完成。");
    const state = load();
    if (!Object.hasOwn(state.installed, id)) return snapshot();
    const item = state.installed[id];
    if (item.skillId) {
      const shared = Object.entries(state.installed).some(([other, entry]) => other !== id && entry.skillId === item.skillId);
      if (!shared) {
        checkSkillUnused(item.skillId, unlink);
        teamSkills.remove(item.skillId);
      }
    }
    delete state.installed[id];
    if (state.theme === id) state.theme = null;
    save(state);
    return snapshot();
  }

  function theme(id) {
    const state = load();
    if (id !== null && (!Object.hasOwn(state.installed, id) || state.installed[id].kind !== "theme")) {
      throw new Error("请先安装此主题。");
    }
    state.theme = id;
    save(state);
    return snapshot();
  }

  return { refresh, snapshot, install, remove, theme };
}
