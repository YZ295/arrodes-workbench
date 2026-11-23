import { randomUUID } from "node:crypto";
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

function readEntry(value) {
  if (!value || Object.entries(fields).some(([field, max]) =>
    typeof value[field] !== "string" || !value[field].trim() || value[field].length > max)) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.id) || value.kind !== "skill") return null;
  let url;
  try { url = new URL(value.source); } catch { return null; }
  if (url.origin !== "https://github.com" || url.username || url.password ||
    !/^\/[^/]+\/[^/]+\/blob\/.+\/SKILL\.md$/.test(url.pathname)) return null;
  return { ...Object.fromEntries(Object.keys(fields).map((field) => [field, value[field]])), source: url.href };
}

export function createMarketplace({ dataDir, teamSkills, fetcher, checkIdle }) {
  const file = join(dataDir, "marketplace.json");
  const catalog = new Map(bundled.map((entry) => [entry.id, entry]));
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
    return { catalog: [...catalog.values()], installed, theme, source, windowColors };
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
        if (!catalog.has(entry.id)) catalog.set(entry.id, entry);
      }
      source = "GitHub 社区目录";
    } catch {
      source = "社区目录暂不可用 · 当前可浏览本机目录";
    }
    return snapshot();
  }

  async function install(id) {
    checkIdle();
    const entry = catalog.get(id);
    if (!entry) throw new Error("此插件已离开目录，请刷新后重试。");
    if (Object.hasOwn(load().installed, id)) return snapshot();
    let skillId;
    if (entry.kind === "skill") {
      if (bundled.some((item) => item.id === id)) {
        const path = new URL(`./skills/${id}/SKILL.md`, import.meta.url);
        skillId = teamSkills.importMarkdown(readFileSync(path), path.pathname);
      } else {
        const item = await fetchGithubSkill(entry.source, fetcher);
        checkIdle();
        skillId = teamSkills.importMarkdown(item.bytes, item.path);
      }
    }
    const state = load();
    state.installed[id] = { ...entry, ...(skillId ? { skillId } : {}) };
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

  return { refresh, snapshot, install, theme };
}
