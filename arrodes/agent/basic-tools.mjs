import { executePowerShell } from "./powershell.mjs";
import { DESKTOP_TARGETS, desktopDetail, desktopTarget } from "./desktop-launch.mjs";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import Papa from "papaparse";
import { getDocumentProxy } from "unpdf";
import { researchPage } from "./web-research.mjs";
import { searchPublic } from "./web-search.mjs";

const exec = promisify(execFile);
const maxFileBytes = 10 * 1024 * 1024;
const textExtensions = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".yaml", ".yml", ".py", ".sql", ".xml", ".toml", ".log"]);
const str = { type: "string" };
const integer = { type: "integer" };
const pathParameter = { path: str };
const value = { type: ["string", "number", "boolean", "null"] };
const rowsParameter = { type: "array", items: { type: "array", items: value } };
const schema = (description, properties, required = Object.keys(properties)) =>
  ({ description, parameters: { type: "object", properties, required } });

const definitions = {
  search_workspace: schema("搜索工作区文件名或文本内容，返回相对路径和匹配行。", { query: str, content: { type: "boolean" } }, ["query"]),
  compare_files: schema("比较两个工作区文本文件，显示变化的行及行号。", { first: str, second: str }),
  preview_archive: schema("预览把多个文件移动到工作区内另一个目录。", { paths: { type: "array", items: str }, directory: str }),
  archive_files: schema("按预览移动文件。应用会显示完整移动清单并要求用户确认。", { paths: { type: "array", items: str }, directory: str }),
  read_document: schema("读取 Markdown、文本、DOCX 或有文字层的 PDF。PDF 按页返回，DOCX 文本按段落。start 从 1 开始，limit 默认为 3。", { path: str, start: integer, limit: integer }, ["path"]),
  read_table: schema("读取 CSV、TSV 或 XLSX；返回表名、行号与单元格，保留来源。start 从 1 开始。", { path: str, sheet: str, start: integer, limit: integer }, ["path"]),
  summarize_table: schema("统计 CSV、TSV 或 XLSX 中指定列的总和、平均、最小、最大与缺失值。column 是从 1 开始的列号。", { path: str, sheet: str, column: integer, header: { type: "boolean" } }, ["path", "column"]),
  export_xlsx: schema("在工作区新建一个 XLSX，rows 为行数组。数值必须用 JSON 数字。", { path: str, rows: rowsParameter, sheet: str }, ["path", "rows"]),
  verify_file: schema("重新打开产物；支持检查文件存在、格式、指定表格单元格的值，JS 另做语法检查。", { path: str, sheet: str, cell: str, expected: value }, ["path"]),
  run_powershell: schema("经用户确认，在当前工作区启动 Windows PowerShell，返回输出和退出码。", { script: str }),
  run_project_check: schema("经用户确认，对一个工作区内的 JavaScript 测试文件运行 node --test。", pathParameter),
  search_web: schema("按关键词搜索公开网页，返回标题、链接和摘要；需要核实正文时调用 research_web。", { query: str, limit: integer }, ["query"]),
  search_github: schema("按关键词搜索 GitHub 公开仓库，返回仓库名、链接、简介和星数；支持 language: 等仓库筛选。", { query: str, limit: integer }, ["query"]),
  research_web: schema("读取给定公开网页或 GitHub/文档 URL，提取标题与正文并返回来源链接。", { url: str }),
  open_desktop: schema("经用户确认打开默认浏览器、回收站、文件资源管理器、记事本、计算器或 Windows 设置。url 仅用于浏览器。", { target: { type: "string", enum: DESKTOP_TARGETS }, url: str }, ["target"]),
  open_workspace_item: schema("经用户确认，在桌面打开工作区内的目录或受支持的文档。", { path: str }, []),
};

export const BASIC_TOOL_NAMES = Object.keys(definitions);
export const BASIC_TOOLS = BASIC_TOOL_NAMES.map((name) => ({ type: "function", function: { name, ...definitions[name] } }));
export const BASIC_READ_TOOLS = ["search_workspace", "compare_files", "preview_archive", "read_document", "read_table", "summarize_table", "verify_file", "search_web", "search_github", "research_web"];
export const FILE_WRITING_TOOLS = new Set(["write_file", "export_xlsx"]);

const fail = (output) => ({ ok: false, output });
const pass = (output) => ({ ok: true, output });
const extension = (path) => extname(path).toLowerCase();
const bounded = (v, fallback, max) => Number.isInteger(v) && v > 0 ? Math.min(v, max) : fallback;
const printable = (rows) => rows.map((row) => JSON.stringify(row).slice(0, 480)).join("\n").slice(0, 6200);

async function fileBytes(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxFileBytes) throw new Error("需要不超过 10 MB 的普通文件。");
  return readFile(path);
}

async function search(root, { query, content }) {
  if (typeof query !== "string" || !query.trim()) return fail("请提供搜索词。");
  const needle = query.toLowerCase();
  const matches = [];
  const pending = [root];
  let visited = 0;
  while (pending.length && matches.length < 30 && visited < 2000) {
    const folder = pending.pop();
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++visited > 2000 || matches.length >= 30) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { pending.push(path); continue; }
      if (!entry.isFile()) continue;
      const name = relative(root, path);
      if (name.toLowerCase().includes(needle)) matches.push(name);
      if (!content || !textExtensions.has(extension(path)) || (await stat(path)).size > 128_000) continue;
      const lines = (await readFile(path, "utf8")).split(/\r?\n/);
      const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
      if (index >= 0) matches.push(`${name}:${index + 1} ${lines[index].slice(0, 180)}`);
    }
  }
  const boundedResult = matches.length >= 30 || visited >= 2000 ? "\n已达到搜索上限。" : "";
  return pass((matches.join("\n").slice(0, 6200) || "未找到匹配。") + boundedResult);
}

async function readDocument(path, args) {
  const bytes = await fileBytes(path);
  const start = bounded(args.start, 1, 100000);
  const limit = bounded(args.limit, 3, 20);
  switch (extension(path)) {
    case ".pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      try {
        const pages = [];
        for (let number = start; number <= Math.min(pdf.numPages, start + limit - 1); number++) {
          const page = await pdf.getPage(number);
          const content = await page.getTextContent();
          const text = content.items.map((item) => item.str ?? "").join(" ").trim();
          pages.push(`第 ${number} 页：${text.slice(0, 3000) || "未提取到文字"}`);
        }
        return pass(`PDF 共 ${pdf.numPages} 页\n${pages.join("\n\n").slice(0, 6100)}`);
      } finally { await pdf.loadingTask.destroy(); }
    }
    case ".docx": {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      const paragraphs = value.split(/\n\s*\n/).filter((line) => line.trim());
      return pass(`共 ${paragraphs.length} 段\n${printable(paragraphs.slice(start - 1, start - 1 + limit).map((text, i) => [start + i, text]))}`);
    }
    default: {
      if (!textExtensions.has(extension(path))) return fail("支持 PDF、DOCX、Markdown 和常见文本文件。");
      const lines = bytes.toString("utf8").split(/\r?\n/);
      return pass(printable(lines.slice(start - 1, start - 1 + limit).map((text, i) => [start + i, text])));
    }
  }
}

function displayed(cell) {
  if (cell && typeof cell === "object" && !(cell instanceof Date)) {
    if (Object.hasOwn(cell, "formula") || Object.hasOwn(cell, "sharedFormula")) return cell.result ?? null;
    if (typeof cell.text === "string") return cell.text;
    if (Array.isArray(cell.richText)) return cell.richText.map(({ text }) => text).join("");
  }
  return cell ?? null;
}

async function readTable(path, name) {
  const bytes = await fileBytes(path);
  const ext = extension(path);
  if (ext === ".csv" || ext === ".tsv") {
    const { data, errors } = Papa.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""), { delimiter: ext === ".csv" ? "," : "\t", skipEmptyLines: true });
    if (errors.length) throw new Error("表格分隔符或引号格式有误。");
    return { name: "表格", sheetNames: ["表格"], rows: data };
  }
  if (ext !== ".xlsx") throw new Error("表格支持 CSV、TSV 和 XLSX。");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheet = name ? book.getWorksheet(name) : book.worksheets[0];
  if (!sheet) throw new Error("未找到工作表。");
  if (sheet.rowCount > 100000 || sheet.columnCount > 1000) throw new Error("工作表超过可处理的范围。");
  const rows = Array.from({ length: sheet.rowCount }, (_, i) => sheet.getRow(i + 1).values.slice(1).map(displayed));
  return { name: sheet.name, sheetNames: book.worksheets.map(({ name }) => name), rows, sheet };
}

function summarize(rows, column, header) {
  if (!Number.isInteger(column) || column < 1) return fail("请提供从 1 开始的列号。");
  let total = 0, compensation = 0, count = 0, missing = 0, invalid = 0, min = Infinity, max = -Infinity;
  for (const row of rows.slice(header ? 1 : 0)) {
    const cell = row[column - 1];
    if (cell == null || String(cell).trim() === "") { missing++; continue; }
    const number = typeof cell === "number" || (typeof cell === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell.trim())) ? Number(cell) : NaN;
    if (!Number.isFinite(number)) { invalid++; continue; }
    const next = number - compensation;
    const sum = total + next;
    compensation = (sum - total) - next;
    total = sum;
    count++;
    min = Math.min(min, number);
    max = Math.max(max, number);
  }
  return pass(JSON.stringify({ column, count, missing, invalid, total: count ? total : null, average: count ? total / count : null, min: count ? min : null, max: count ? max : null }));
}

async function moveWithoutReplacing(source, target) {
  await copyFile(source, target, constants.COPYFILE_EXCL);
  try {
    await unlink(source);
  } catch (error) {
    try { await unlink(target); }
    catch { throw new Error("未能移除复制的目标，请手动核对源文件和目标文件。"); }
    throw error;
  }
}

async function archivePlan(root, args, safePath) {
  if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 20 || !args.paths.every((p) => typeof p === "string")) {
    throw new Error("每次请选择 1–20 个文件。");
  }
  const directory = safePath(root, args.directory);
  const moves = [];
  const targets = new Set();
  for (const path of args.paths) {
    const source = safePath(root, path);
    const item = await lstat(source);
    if (!item.isFile() || item.isSymbolicLink()) throw new Error("只能归档普通文件。");
    const target = safePath(root, relative(root, join(directory, relative(dirname(source), source))));
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (targets.has(key) || await lstat(target).catch((error) => { if (error.code !== "ENOENT") throw error; })) {
      throw new Error("目标已有同名文件，或移动清单含重复目标。");
    }
    targets.add(key);
    moves.push({ source, target });
  }
  return { directory, moves };
}

export async function executeBasicTool(name, args, root, { safePath, approveAction, openItem, launchDesktop, verifyWorkspaceFile }) {
  const path = () => safePath(root, args.path);
  const confirm = (action, detail, fields) => approveAction?.({ action, detail, ...fields });
  switch (name) {
    case "search_workspace": return search(root, args);
    case "compare_files": {
      const lines = await Promise.all([args.first, args.second].map(async (name) =>
        (await fileBytes(safePath(root, name))).toString("utf8").split(/\r?\n/)));
      const changes = [];
      for (let i = 0; i < Math.max(...lines.map(({ length }) => length)) && changes.length < 30; i++) {
        if (lines[0][i] !== lines[1][i]) changes.push([i + 1, lines[0][i], lines[1][i]]);
      }
      return pass(changes.length ? printable(changes) : "两份文件文本一致。");
    }
    case "preview_archive":
    case "archive_files": {
      const { directory, moves } = await archivePlan(root, args, safePath);
      const plan = moves.map(({ source, target }) => `${relative(root, source)} → ${relative(root, target)}`).join("\n");
      if (name === "preview_archive") return pass(plan);
      if (!await confirm("移动工作区文件", plan)) return fail("用户未批准移动。");
      const checked = await archivePlan(root, args, safePath);
      await mkdir(directory, { recursive: true });
      const completed = [];
      try {
        for (const move of checked.moves) {
          await moveWithoutReplacing(move.source, move.target);
          completed.push(move);
        }
      } catch (error) {
        const restores = await Promise.allSettled(completed.reverse().map(({ source, target }) => moveWithoutReplacing(target, source)));
        return fail(restores.some(({ status }) => status === "rejected")
          ? "移动失败，部分文件未能恢复。请检查原目录和目标目录。" : `移动失败，已撤回已完成的移动：${error.message}`);
      }
      return pass(plan);
    }
    case "read_document": return readDocument(path(), args);
    case "read_table": {
      const { name, sheetNames, rows } = await readTable(path(), args.sheet);
      const start = bounded(args.start, 1, 100000);
      const limit = bounded(args.limit, 25, 100);
      return pass(`工作表：${name}（${sheetNames.join("、")}）共 ${rows.length} 行\n${printable(rows.slice(start - 1, start - 1 + limit).map((row, index) => [start + index, row]))}`);
    }
    case "summarize_table": return summarize((await readTable(path(), args.sheet)).rows, args.column, args.header !== false);
    case "export_xlsx": {
      const target = path();
      const rows = args.rows;
      if (extension(target) !== ".xlsx" || !Array.isArray(rows) || rows.length < 1 || rows.length > 5000 ||
        rows.some((row) => !Array.isArray(row) || row.length > 100 || row.some((cell) =>
          cell != null && !["number", "boolean", "string"].includes(typeof cell) || typeof cell === "string" && cell.length > 32767))) {
        return fail("请提供 .xlsx 文件名及有效的表格行。");
      }
      const book = new ExcelJS.Workbook();
      book.addWorksheet(args.sheet || "结果").addRows(rows);
      const bytes = Buffer.from(await book.xlsx.writeBuffer());
      if (bytes.length > maxFileBytes) return fail("表格超过 10 MB。");
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, bytes, { flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") return fail("目标 XLSX 已存在，请换一个文件名后重试。");
        throw error;
      }
      return { ...pass(`已导出 ${args.path}，共 ${rows.length} 行。`), artifact: args.path };
    }
    case "verify_file": {
      if (!args.cell) return verifyWorkspaceFile(root, args.path);
      if (extension(path()) !== ".xlsx" || !/^[A-Z]{1,3}[1-9]\d{0,5}$/i.test(args.cell) || !Object.hasOwn(args, "expected")) return fail("请提供 XLSX、单元格和预期值。");
      const { sheet } = await readTable(path(), args.sheet);
      const actual = displayed(sheet.getCell(args.cell.toUpperCase()).value);
      return { ok: Object.is(actual, args.expected), output: JSON.stringify({ cell: args.cell, actual, expected: args.expected }) };
    }
    case "run_powershell": {
      const { script } = args;
      if (process.platform !== "win32" || !process.env.SystemRoot) return fail("当前环境没有 Windows PowerShell。");
      if (typeof script !== "string" || !script.trim() || script.length > 2500 ||
          /[\p{Cc}\p{Cf}]/u.test(script.replace(/[\r\n\t]/g, ""))) {
        return fail("请提供 1–2500 字符的 PowerShell 脚本，避免隐藏控制字符。");
      }
      const cwd = await realpath(root);
      if (!await confirm("运行 PowerShell", `工作目录：${cwd}\n脚本会以当前用户权限运行，可访问工作区以外的文件和网络。\n\n${script}`, { cwd, script })) {
        return { ...fail("用户取消了执行。"), cancelled: true };
      }
      return executePowerShell(script, cwd);
    }
    case "run_project_check": {
      const target = path();
      if (!/\.(?:js|mjs|cjs)$/i.test(target) || !await confirm("运行工作区测试", `node --test "${target}"\n测试脚本以你的系统账户运行，可以访问该账户有权访问的文件与网络。`)) {
        return fail("用户未批准运行，或测试文件不是 JavaScript。");
      }
      await access(target, constants.R_OK);
      const options = { cwd: root, timeout: 30000, maxBuffer: 256000, windowsHide: true,
        env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ELECTRON_RUN_AS_NODE: "1" } };
      try {
        const { stdout, stderr } = await exec(process.execPath, ["--test", target], options);
        return pass((stdout + stderr).slice(-6000));
      } catch (error) { return fail(String(error.stdout || error.stderr || error.message).slice(-6000)); }
    }
    case "search_web":
    case "search_github": return pass(JSON.stringify(await searchPublic(name, args)));
    case "research_web": return pass(await researchPage(args.url));
    case "open_desktop": {
      const target = desktopTarget(args);
      const detail = desktopDetail(target);
      if (!launchDesktop || !await confirm("打开 Windows 应用", detail, target.url ? undefined : { risk: "routine" })) return fail("桌面启动不可用或用户未批准。");
      await launchDesktop(target);
      return pass(`已向 Windows 发出打开请求：${detail}`);
    }
    case "open_workspace_item": {
      const target = args.path === undefined ? resolve(root) : path();
      const info = await stat(target);
      if (!info.isDirectory() && ![".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"].includes(extension(target))) {
        return fail("只能打开工作区内的目录或受支持的文档。");
      }
      if (!openItem || !await confirm("打开桌面项目", target, { risk: "routine" })) return fail("用户未批准打开。");
      const error = await openItem(await realpath(target));
      return error ? fail(error) : pass(`已打开 ${args.path ?? "工作区"}。`);
    }
    default: return fail("未知工具。");
  }
}

export async function verifyStructuredFile(path) {
  if ([".csv", ".tsv", ".xlsx"].includes(extension(path))) {
    const { name, rows } = await readTable(path);
    return pass(`表格可打开：${name}，${rows.length} 行。`);
  }
  if ([".pdf", ".docx"].includes(extension(path))) {
    const result = await readDocument(path, { limit: 1 });
    return result.ok ? pass("文档可打开。") : result;
  }
  return null;
}
