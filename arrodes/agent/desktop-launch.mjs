import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

const targets = {
  browser: "默认浏览器",
  recycle_bin: "回收站",
  explorer: "文件资源管理器",
  notepad: "记事本",
  calculator: "计算器",
  settings: "Windows 设置",
};

export const DESKTOP_TARGETS = Object.keys(targets);
export const DEFAULT_BROWSER_URL = "https://www.bing.com/";

export function desktopTarget(args) {
  if (!Object.hasOwn(targets, args.target)) throw new Error("请选择支持的 Windows 应用。");
  const { target } = args;
  if (args.url === undefined) return { target };
  if (target !== "browser" || typeof args.url !== "string" || args.url.length > 2048) {
    throw new Error("只有浏览器支持指定网页地址。");
  }
  const url = new URL(args.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("浏览器只接受 HTTP 或 HTTPS 地址。");
  }
  return { target, url: url.href };
}

export function desktopDetail({ target, url }) {
  return target === "browser" ? `${targets[target]}\n${url ?? DEFAULT_BROWSER_URL}` : targets[target];
}

export async function launchWindowsDesktop(input, openExternal) {
  const { target, url } = desktopTarget(input);
  if (process.platform !== "win32") throw new Error("此工具需要 Windows。");
  if (target === "browser") return openExternal(url ?? DEFAULT_BROWSER_URL);
  if (target === "settings") return openExternal("ms-settings:");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("无法定位 Windows 系统目录。");
  const executable = target === "notepad" ? join(systemRoot, "System32", "notepad.exe")
    : target === "calculator" ? join(systemRoot, "System32", "calc.exe")
    : join(systemRoot, "explorer.exe");
  const args = target === "recycle_bin" ? ["shell:RecycleBinFolder"] : [];
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
