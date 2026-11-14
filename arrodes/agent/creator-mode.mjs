import { lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

const textExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".html", ".css", ".json", ".md"]);
const ignoredDirectories = new Set(["node_modules", "release", "dist", "data", "vendor"]);

export async function isArrodesSource(root, liveAppPath) {
  try {
    const canonical = await realpath(root);
    const live = await realpath(liveAppPath);
    const key = (path) => process.platform === "win32" ? path.toLowerCase() : path;
    if (key(live) === key(canonical) || key(live).startsWith(key(canonical + sep))) return false;
    const desktop = JSON.parse(await readFile(join(canonical, "arrodes", "package.json"), "utf8"));
    return desktop.name === "arrodes" &&
      (await stat(join(canonical, "arrodes", "agent", "loop.mjs"))).isFile() &&
      (await stat(join(canonical, "arrodes", "ui", "index.html"))).isFile() &&
      (await lstat(join(canonical, ".git"))).isDirectory();
  } catch { return false; }
}

function diffText(before, after) {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  let first = 0, endOld = oldLines.length, endNew = newLines.length;
  while (first < endOld && first < endNew && oldLines[first] === newLines[first]) first++;
  while (endOld > first && endNew > first && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--; endNew--;
  }
  return [`@@ 第 ${first + 1} 行 @@`,
    ...oldLines.slice(first, endOld).map((line) => "- " + line),
    ...newLines.slice(first, endNew).map((line) => "+ " + line)].join("\n");
}

async function snapshot(target) {
  const info = await lstat(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) throw new Error("请选择小于 128 KB 的普通源码文件。");
  return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(target)), mode: info.mode };
}

export async function editSource(root, args, safePath, approveAction) {
  const { path, content } = args;
  const target = safePath(root, path);
  if (path.split(/[/\\]+/).some((part) => part.startsWith(".") || ignoredDirectories.has(part.toLowerCase())) ||
      !textExtensions.has(extname(target).toLowerCase()) || typeof content !== "string" || Buffer.byteLength(content) > 128 * 1024) {
    return { ok: false, output: "请选择可编辑的源码文件，大小不超过 128 KB。" };
  }
  const before = await snapshot(target);
  if (before?.text === content) return { ok: true, output: "文件内容没有变化。" };
  const diff = diffText(before?.text ?? "", content);
  if (diff.length > 6500 || /[\p{Cc}\p{Cf}]/u.test(diff.replace(/[\r\n\t]/g, ""))) {
    return { ok: false, output: "变更太大或含隐藏控制字符，请拆成可审阅的小改动。" };
  }
  const parent = dirname(target);
  if (resolve(await realpath(parent)) !== parent) return { ok: false, output: "请选择源码工作区内的实际目录。" };
  if (!await approveAction?.({ action: "应用源码修改", detail: `${target}\n\n${diff}` })) {
    return { ok: false, output: "用户取消，文件未修改。" };
  }
  if (safePath(root, path) !== target || resolve(await realpath(parent)) !== parent || (await snapshot(target))?.text !== before?.text) {
    return { ok: false, output: "确认期间文件已变化，请重新读取后再修改。" };
  }
  if (!before) {
    await writeFile(target, content, { flag: "wx" });
  } else {
    const pending = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
    await writeFile(pending, content, { flag: "wx", mode: before.mode });
    try { await rename(pending, target); }
    catch (error) { await unlink(pending).catch(() => {}); throw error; }
  }
  return { ok: true, output: `已更新源码 ${path}。` };
}
