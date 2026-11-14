import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function executePowerShell(script, cwd) {
  const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!isAbsolute(executable)) throw new Error("无法定位 Windows PowerShell。");
  const source = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    "& {",
    script,
    "}",
    'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
  ].join("\r\n");
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const format = (stdout, stderr) => {
    const combined = [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n");
    return combined.length > 5500 ? combined.slice(0, 5500) + "\n（输出已截断）" : combined;
  };
  try {
    const { stdout, stderr } = await exec(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      cwd, env, timeout: 60000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    return { ok: true, exitCode: 0, output: format(stdout, stderr) || "PowerShell 执行完成，无输出。" };
  } catch (error) {
    const exitCode = Number.isInteger(error.code) ? error.code : null;
    const reason = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "PowerShell 输出超过上限，进程已停止。"
      : error.killed ? "PowerShell 运行超时，已终止 PowerShell 进程。"
      : exitCode !== null ? `PowerShell 退出码：${exitCode}` : `无法执行 PowerShell：${error.message}`;
    return { ok: false, exitCode, output: [reason, format(error.stdout, error.stderr)].filter(Boolean).join("\n") };
  }
}
