import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { parseDocument, DomUtils } from "htmlparser2";
import ipaddr from "ipaddr.js";

const maxBytes = 1024 * 1024;
const allowedHosts = (address) => ipaddr.process(address).range() === "unicast";
const normalize = (text) => text.replace(/\s+/g, " ").trim();

async function fetchPublic(url) {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("仅支持公开 HTTPS 网页。");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !allowedHosts(address))) throw new Error("不能访问本机或内网地址。");
  const [{ address, family }] = addresses;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      family,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
      headers: { accept: "text/html,text/plain,application/xhtml+xml", "user-agent": "Arrodes-Web-Reader" },
      signal: AbortSignal.timeout(12000),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve({ redirect: res.headers.location });
        return;
      }
      if (res.statusCode !== 200 || !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(res.headers["content-type"] ?? "")) {
        res.resume();
        reject(new Error(`无法读取该网页（HTTP ${res.statusCode} 或格式不支持）。`));
        return;
      }
      const chunks = [];
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) res.destroy(new Error("网页超过 1 MB。"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), html: !res.headers["content-type"].startsWith("text/plain") }));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function researchPage(input) {
  let url = new URL(input);
  for (let i = 0; i < 4; i++) {
    const result = await fetchPublic(url);
    if (result.redirect) {
      url = new URL(result.redirect, url);
      continue;
    }
    if (!result.html) return `来源：${url.href}\n${result.body.slice(0, 5600)}`;
    const doc = parseDocument(result.body);
    for (const tag of ["script", "style", "noscript", "template", "nav", "footer"]) {
      for (const element of DomUtils.getElementsByTagName(tag, doc.children)) DomUtils.removeElement(element);
    }
    const first = (tag) => DomUtils.getElementsByTagName(tag, doc.children, true, 1)[0];
    const title = first("title");
    const content = first("main") ?? first("article") ?? first("body") ?? doc;
    return `来源：${url.href}\n标题：${title ? normalize(DomUtils.textContent(title)).slice(0, 240) : ""}\n${normalize(DomUtils.innerText(content)).slice(0, 5300)}`;
  }
  throw new Error("网页跳转过多。");
}
