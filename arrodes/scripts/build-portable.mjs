import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
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
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const packaged = spawnSync(process.execPath, [
    join(repository, "node_modules/electron-builder/cli.js"), "--win", "portable",
    `--config.directories.output=${output}`, "--config.npmRebuild=false",
  ], { cwd: temporary, env, stdio: "inherit" });
  if (packaged.error) throw packaged.error;
  process.exitCode = packaged.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
