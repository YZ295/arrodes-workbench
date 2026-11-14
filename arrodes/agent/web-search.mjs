import { parseDocument, DomUtils } from "htmlparser2";

const clean = (text, limit) => typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, limit) : "";
const byClass = (name, nodes) => DomUtils.findAll((node) => node.attribs?.class?.split(/\s+/).includes(name), nodes);

function publicLink(href) {
  if (typeof href !== "string" || !href) return null;
  try {
    let url = new URL(href, "https://www.bing.com/");
    if (url.hostname === "www.bing.com" && url.pathname === "/ck/a") {
      const encoded = url.searchParams.get("u");
      if (!encoded?.startsWith("a1")) return null;
      url = new URL(Buffer.from(encoded.slice(2), "base64url").toString("utf8"));
    }
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function parseWebResults(html) {
  const document = parseDocument(html);
  return byClass("b_algo", document.children).flatMap((item) => {
    const heading = DomUtils.getElementsByTagName("h2", [item], true, 1)[0];
    const link = heading && DomUtils.getElementsByTagName("a", [heading], true, 1)[0];
    const title = link && clean(DomUtils.textContent(link), 200);
    const url = publicLink(link?.attribs.href);
    const paragraph = DomUtils.getElementsByTagName("p", [item], true, 1)[0];
    if (!url || !title) return [];
    return [{ title, url, snippet: paragraph ? clean(DomUtils.textContent(paragraph), 280) : "" }];
  });
}

async function fetchSearch(url, accept, redirects = 2) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept, "user-agent": "Arrodes-Search/1.0" },
      redirect: "manual", signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error("搜索服务连接失败或超时，请稍后重试。");
  }
  if (response.status === 302 || response.status === 301 || response.status === 307 || response.status === 308) {
    await response.body?.cancel();
    const location = response.headers.get("location");
    const next = location && new URL(location, url);
    if (!redirects || !next || next.protocol !== "https:" || next.username || next.password ||
      next.port || !["www.bing.com", "cn.bing.com"].includes(url.hostname) ||
      !["www.bing.com", "cn.bing.com"].includes(next.hostname) || next.pathname !== "/search") {
      throw new Error("搜索服务返回了不受支持的跳转。");
    }
    return fetchSearch(next, accept, redirects - 1);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 429 || response.status === 403
      ? "搜索服务限流或拒绝访问，请稍后重试。"
      : `搜索服务请求失败（HTTP ${response.status}）。`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("搜索结果超过处理上限。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function searchPublic(kind, { query, limit }) {
  if (typeof query !== "string" || !query.trim() || query.trim().length > 200) {
    throw new Error("请输入 1–200 个字符的搜索关键词。");
  }
  const count = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 8) : 5;
  if (kind === "search_web") {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", query.trim());
    const html = await fetchSearch(url, "text/html");
    const seen = new Set();
    const results = parseWebResults(html).filter(({ url: source }) => {
      if (seen.has(source)) return false;
      seen.add(source);
      return true;
    }).slice(0, count);
    if (results.length === 0 && !/\bb_no\b/.test(html)) throw new Error("网页搜索服务没有返回可解析的结果，请重试或使用 GitHub 搜索。");
    return { provider: "Bing", results };
  }
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("per_page", String(count));
  const response = JSON.parse(await fetchSearch(url, "application/vnd.github+json"));
  if (!Array.isArray(response.items)) throw new Error("GitHub 搜索响应格式无效。");
  const results = response.items.slice(0, count).flatMap((repo) => {
    if (!repo || typeof repo.full_name !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)) return [];
    return [{
      title: repo.full_name,
      url: `https://github.com/${repo.full_name}`,
      snippet: clean(repo.description, 280),
      stars: repo.stargazers_count,
      language: repo.language,
    }];
  });
  return { provider: "GitHub", incomplete: response.incomplete_results === true, results };
}
