import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "./build-runtime.mjs";

const desktop = resolve(import.meta.dirname, "..");
const repository = resolve(desktop, "..");
const output = resolve(desktop, process.argv[2] ?? "release/collaboration");
const temporary = mkdtempSync(join(tmpdir(), "arrodes-portable-"));
try {
  for (const entry of ["main.js", "preload.cjs", "package.json", "agent", "ui"]) {
    cpSync(join(desktop, entry), join(temporary, entry), { recursive: true });
  }
  await buildRuntime(join(temporary, "agent/collab-runtime.mjs"));
  const manifestPath = join(temporary, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rootManifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: rootManifest.dependencies }, null, 2));
  cpSync(join(repository, "package-lock.json"), join(temporary, "package-lock.json"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("请通过 npm run build:portable 构建。");
  const installed = spawnSync(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: temporary, env, stdio: "inherit",
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw new Error("便携包运行依赖安装失败。");
  const electronDist = join(repository, "node_modules", "electron", "dist");
  const electronOptions = existsSync(join(electronDist, "electron.exe"))
    ? [`--config.electronDist=${electronDist}`] : [];
  const packaged = spawnSync(process.execPath, [
    join(repository, "node_modules/electron-builder/cli.js"), "--win", "portable",
    `--config.directories.output=${output}`, "--config.npmRebuild=false", ...electronOptions,
  ], { cwd: temporary, env, stdio: "inherit" });
  if (packaged.error) throw packaged.error;
  process.exitCode = packaged.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
