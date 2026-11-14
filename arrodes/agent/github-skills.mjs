import { MAX_SKILL_BYTES } from "./team-skills.mjs";

const apiOrigin = "https://api.github.com";
const markdownLimit = 96 * 1024;
const treeLimit = 8 * 1024 * 1024;
const skillFile = "SKILL.md";
const invalidUrl = "请输入公开 GitHub 仓库、技能目录或 SKILL.md 的 HTTPS 地址。";
const encodePath = (parts) => parts.map(encodeURIComponent).join("/");

function readLink(input) {
  let url;
  let parts;
  try {
    if (typeof input !== "string" || input.length > 2048) throw new Error();
    url = new URL(input.trim());
    parts = url.pathname.replace(/\/$/, "").split("/").slice(1).map(decodeURIComponent);
  } catch {
    throw new Error(invalidUrl);
  }
  const raw = url.hostname === "raw.githubusercontent.com";
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !(raw || url.hostname === "github.com" || url.hostname === "www.github.com")) throw new Error(invalidUrl);
  const [owner, repoName, ...rest] = parts;
  const repo = repoName?.replace(/\.git$/i, "");
  if (!owner || !/^[a-z0-9-]+$/i.test(owner) || !repo || !/^[a-z0-9_.-]+$/i.test(repo) ||
      repo === "." || repo === ".." ||
      rest.some((part) => !part || part.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
        /[\\\u0000-\u001f]/.test(part))) throw new Error(invalidUrl);
  if (!raw && !rest.length) return { owner, repo, kind: "tree", locations: [{ path: [] }] };
  const kind = raw ? "blob" : rest.shift();
  if (!["blob", "tree"].includes(kind) || !rest.length || (kind === "blob" && rest.at(-1) !== skillFile)) throw new Error(invalidUrl);
  if (raw && rest[0] === "refs" && ["heads", "tags"].includes(rest[1])) {
    const prefix = rest.splice(0, 2).join("/");
    rest[0] = `${prefix}/${rest[0]}`;
  }
  const count = Math.min(kind === "tree" ? rest.length : rest.length - 1, 8);
  const locations = Array.from({ length: count }, (_, index) => ({
    ref: rest.slice(0, index + 1).join("/"),
    path: rest.slice(index + 1),
  })).filter(({ path }) => path.every((segment) => !segment.includes("/")));
  if (!locations.length) throw new Error(invalidUrl);
  return { owner, repo, kind, locations };
}

async function getJSON(fetcher, url, signal, limit) {
  let response;
  try {
    response = await fetcher(url, {
      signal, redirect: "error",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Arrodes-Skill-Import" },
    });
  } catch {
    throw new Error("无法连接 GitHub，请检查网络后重试。");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    if (response.status === 403 || response.status === 429) throw new Error("GitHub 拒绝访问或请求过多，请确认仓库公开后稍后重试。");
    throw new Error(`GitHub 请求失败（${response.status}），请稍后重试。`);
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body ?? []) {
      length += chunk.byteLength;
      if (length > limit) throw new Error("GitHub 返回的数据过大，请粘贴具体的 SKILL.md 地址。");
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) throw new Error("GitHub 请求超时，请重试。");
    throw error;
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("GitHub 返回的数据无法读取，请稍后重试。"); }
}

export async function fetchGithubSkill(input, fetcher = globalThis.fetch) {
  const { owner, repo, kind, locations } = readLink(input);
  const repository = `/repos/${owner}/${repo}`;
  const signal = AbortSignal.timeout(15000);
  const get = (route, limit) => getJSON(fetcher, new URL(repository + route, apiOrigin), signal, limit);
  async function readFile(parts, ref) {
    const data = await get(`/contents/${encodePath(parts)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, markdownLimit);
    if (!data) return null;
    if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") {
      throw new Error("这个地址没有可读取的 SKILL.md 文件。");
    }
    const bytes = Buffer.from(data.content, "base64");
    if (data.size > MAX_SKILL_BYTES || bytes.length > MAX_SKILL_BYTES) throw new Error("Skill 文件不能超过 32 KB。");
    if (!bytes.length || bytes.length !== data.size) throw new Error("SKILL.md 内容不完整。");
    return { bytes, path: parts.join("/") };
  }
  for (const { ref, path } of locations) {
    const found = await readFile(kind === "blob" ? path : [...path, skillFile], ref);
    if (found) return found;
    if (kind === "blob") continue;
    const treeRef = ref ?? "HEAD";
    const tree = await get(`/git/trees/${encodeURIComponent(treeRef)}?recursive=1`, treeLimit);
    if (!tree || !Array.isArray(tree.tree)) continue;
    if (tree.truncated) throw new Error("仓库太大，请粘贴具体的 SKILL.md 地址。");
    const directory = path.join("/");
    if (directory && !tree.tree.some((entry) => entry.type === "tree" && entry.path === directory)) continue;
    const prefix = directory ? `${directory}/` : "";
    const matches = tree.tree.filter((entry) => entry.type === "blob" && ["100644", "100755"].includes(entry.mode) &&
      typeof entry.path === "string" && entry.path.startsWith(prefix) && entry.path.split("/").at(-1) === skillFile);
    if (matches.length === 1) {
      const only = await readFile(matches[0].path.split("/"), treeRef);
      if (only) return only;
    }
    if (matches.length > 200) throw new Error("找到的 Skill 太多，请粘贴更具体的目录地址。");
    if (matches.length > 1) return { choices: matches.map(({ path }) => ({
      path,
      url: `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(treeRef)}/${encodePath(path.split("/"))}`,
    })) };
    break;
  }
  throw new Error("没有找到 SKILL.md。请确认仓库公开，并检查分支、目录或文件链接。");
}
