import { approveOperation } from "./agent/approval-policy.mjs";
import { isArrodesSource } from "./agent/creator-mode.mjs";
import { launchWindowsDesktop } from "./agent/desktop-launch.mjs";
import { app, BrowserWindow, dialog, Menu, ipcMain, net, safeStorage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { runAgentTurn, safePath } from "./agent/loop.mjs";
import { DEEPSEEK_API, DEEPSEEK_FLASH, deepSeekModelId } from "./agent/deepseek.mjs";
import { listAvailableModels, resolveModelConnection, testModelConnection } from "./agent/model-connection.mjs";
import { getTeamRoles, runTeamTurn } from "./agent/team.mjs";
import { createTeamRoleStore } from "./agent/team-roles.mjs";
import { createTeamCanvasStore } from "./agent/team-canvas.mjs";
import { createTeamSkillStore, validateSkillIds, skillInstructions, BASIC_AGENT_SKILLS } from "./agent/team-skills.mjs";
import { fetchGithubSkill } from "./agent/github-skills.mjs";
import { createWorkspaceStore, existingDirectory } from "./agent/workspaces.mjs";

/**
 * 谦卑之心（Arrodes）——独立 Windows 应用。
 *
 * 自包含：对话、工具执行、工作空间都在本目录内完成。
 * 不依赖 apps/server、不依赖网页路由；安装包里只有本目录的文件。
 */

const DATA_DIR = join(app.getPath("userData"), "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const CONVERSATIONS_DIR = join(DATA_DIR, "conversations");
const DEFAULT_WORKSPACE = "默认工作区";
const workspaces = createWorkspaceStore(DATA_DIR);
const teamRoles = createTeamRoleStore(DATA_DIR);
const teamCanvases = createTeamCanvasStore(DATA_DIR);
const teamSkills = createTeamSkillStore(DATA_DIR);

let win = null;
let conversation;
let turnRunning = false;
let selectedParent = null;

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (config.encryptedKey) {
      config.apiKey = safeStorage.decryptString(Buffer.from(config.encryptedKey, "base64"));
    }
    return config;
  } catch {
    return null;
  }
}

async function chooseDirectory(title) {
  const result = await dialog.showOpenDialog(win, { title, properties: ["openDirectory"] });
  return result.canceled || !result.filePaths[0] ? null : existingDirectory(result.filePaths[0]);
}

function loadConversations() {
  mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  const files = readdirSync(CONVERSATIONS_DIR, { withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith(".json"))
    .map((file) => ({ name: file.name, path: join(CONVERSATIONS_DIR, file.name) }));
  const conversations = [];
  for (const file of files) {
    try {
      const saved = JSON.parse(readFileSync(file.path, "utf8"));
      if (typeof saved.id !== "string" || !/^[a-f0-9-]{36}$/.test(saved.id) || file.name !== `${saved.id}.json`) continue;
      if (!Array.isArray(saved.history) || !saved.history.every((message) => (
        message && ["user", "assistant", "error"].includes(message.role) && typeof message.content === "string"
      ))) continue;
      saved.workspaceId ??= saved.workspaceName;
      if (typeof saved.workspaceId !== "string" || !saved.workspaceId) continue;
      conversations.push({ saved, time: statSync(file.path).mtimeMs });
    } catch {
      // An unreadable conversation must not prevent the next one from opening.
    }
  }
  return conversations.sort((a, b) => b.time - a.time).map(({ saved }) => saved);
}

function newConversation(workspaceId) {
  const workspace = workspaces.get(workspaceId);
  if (!workspace?.available) throw new Error("工作区位置不可用，请重新选择。");
  return { id: randomUUID(), workspaceId, workspaceName: workspace.name, history: [] };
}

function writeConversation(next) {
  const path = join(CONVERSATIONS_DIR, `${next.id}.json`);
  const pending = `${path}.tmp`;
  writeFileSync(pending, JSON.stringify(next, null, 2), "utf8");
  renameSync(pending, path);
}

function saveConversation(next) {
  writeConversation(next);
  conversation = next;
}

ipcMain.handle("config:get", () => {
  const config = loadConfig();
  if (!config) return { configured: false, baseUrl: DEEPSEEK_API, modelId: DEEPSEEK_FLASH };
  return {
    configured: Boolean(config.apiKey && config.apiKey !== "(kept)"),
    baseUrl: config.baseUrl,
    modelId: deepSeekModelId(config.baseUrl, config.modelId),
  };
});

ipcMain.handle("config:listModels", (_event, draft) => {
  const config = resolveModelConnection(draft, loadConfig());
  return config.error ? config : listAvailableModels(config);
});

ipcMain.handle("config:testModel", (_event, draft) => {
  const config = resolveModelConnection(draft, loadConfig());
  return config.error ? config : testModelConnection(config);
});

ipcMain.handle("config:save", (_event, draft) => {
  const config = resolveModelConnection(draft, loadConfig());
  if (config.error) return { ok: false, error: config.error };
  if (!config.modelId) return { ok: false, error: "请先选择或填写模型。" };
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "请确认 Windows 凭据保护可用。" };
  }
  const { baseUrl, modelId, apiKey } = config;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        baseUrl,
        modelId,
        encryptedKey: safeStorage.encryptString(apiKey).toString("base64"),
      },
      null,
      2,
    ),
    "utf8",
  );
  return { ok: true };
});

ipcMain.handle("workspaces:list", () => workspaces.list());

ipcMain.handle("workspaces:chooseParent", async () => {
  const path = await chooseDirectory("选择新工作区的位置");
  if (path) selectedParent = path;
  return path;
});

ipcMain.handle("workspaces:attach", async () => {
  const path = await chooseDirectory("添加已有工作区文件夹");
  return path ? workspaces.attach(path).id : null;
});

ipcMain.handle("workspaces:create", (_event, name, location) => {
  if (location && location !== selectedParent) throw new Error("请先选择工作区位置。");
  const workspace = workspaces.create(name, location);
  if (location) selectedParent = null;
  return workspace.id;
});

ipcMain.handle("workspaces:open", async (_event, id) => {
  try {
    const workspace = workspaces.get(id);
    if (!workspace?.available) return { ok: false, error: "工作区位置不可用，请检查文件夹或磁盘。" };
    const error = await shell.openPath(workspace.path);
    return error ? { ok: false, error: "无法打开这个工作区。" } : { ok: true };
  } catch {
    return { ok: false, error: "无法打开这个工作区。" };
  }
});

ipcMain.handle("chat:get", () => conversation);
ipcMain.handle("chat:roles", () => getTeamRoles(teamRoles.list()));

ipcMain.handle("canvas:get", (_event, workspaceId) => {
  if (!workspaces.get(workspaceId)) throw new Error("找不到工作区。");
  return { graph: teamCanvases.get(workspaceId), roles: getTeamRoles(teamRoles.list()), skills: teamSkills.catalog() };
});

ipcMain.handle("canvas:save", (_event, workspaceId, graph) => {
  try {
    if (turnRunning) throw new Error("协作完成后才能编辑画布。");
    if (!workspaces.get(workspaceId)) throw new Error("找不到工作区。");
    return { ok: true, graph: teamCanvases.save(workspaceId, graph, getTeamRoles(teamRoles.list()), teamSkills.list()) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("canvas:importSkill", async () => {
  try {
    if (turnRunning) throw new Error("协作结束后可导入 Skill。");
    const result = await dialog.showOpenDialog(win, {
      title: "导入 SKILL.md", properties: ["openFile"], filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled) return { ok: true };
    const id = teamSkills.importFile(result.filePaths[0]);
    return { ok: true, id, skills: teamSkills.catalog() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("canvas:importGithubSkill", async (_event, link) => {
  try {
    if (turnRunning) throw new Error("协作结束后可导入 Skill。");
    const result = await fetchGithubSkill(link, (url, options) => net.fetch(url, options));
    if (result.choices) return { ok: true, choices: result.choices };
    if (turnRunning) throw new Error("协作已开始，请在结束后重新导入。");
    const id = teamSkills.importMarkdown(result.bytes, result.path);
    return { ok: true, id, skills: teamSkills.catalog() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("canvas:artifact", async (_event, workspaceId, ref, reveal) => {
  try {
    const workspace = workspaces.get(workspaceId);
    if (workspaceId !== conversation.workspaceId || !workspace?.available || typeof ref !== "string") throw new Error();
    const path = safePath(workspace.path, ref);
    if (!statSync(path).isFile()) throw new Error();
    if (reveal === true) shell.showItemInFolder(path);
    else if (/\.(?:txt|md|csv|tsv|json|jsonl|[cm]?js|tsx?|py|html?|css|ya?ml|xml|log)$/i.test(path)) {
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(32769);
        const { bytesRead } = await file.read(buffer);
        return { ok: true, preview: buffer.subarray(0, Math.min(32768, bytesRead)).toString("utf8"), truncated: bytesRead > 32768 };
      } finally {
        await file.close();
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "无法读取该交接文件。文件可能已移走，或不在工作区内。" };
  }
});

ipcMain.handle("chat:createRole", (_event, input) => {
  let skillIds;
  try {
    const available = new Map(teamSkills.list().map((skill) => [skill.id, skill]));
    skillIds = validateSkillIds(input?.skillIds ?? [], available);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try {
    const created = teamRoles.create(input, getTeamRoles().map(({ name }) => name), skillIds);
    return created.ok ? { ok: true, roles: getTeamRoles(created.roles) } : created;
  } catch {
    return { ok: false, error: "无法保存角色，请检查本地数据目录后重试。" };
  }
});

ipcMain.handle("chat:list", () => loadConversations().map(({ id, workspaceId, workspaceName, history, archived }) => ({
  id,
  workspaceId,
  workspaceName,
  archived: archived === true,
  title: history.find(({ role }) => role === "user")?.content.trim().replace(/\s+/g, " ").slice(0, 80) || "新会话",
})));

ipcMain.handle("chat:open", (_event, id) => {
  if (turnRunning) throw new Error("请等当前消息处理完成。");
  const saved = loadConversations().find((entry) => entry.id === id);
  if (!saved) throw new Error("找不到这段会话。");
  if (saved.archived === true) conversation = saved;
  else saveConversation(saved);
  return conversation;
});

ipcMain.handle("chat:archive", (_event, id, archived) => {
  if (turnRunning) throw new Error("请等当前消息处理完成。");
  const saved = loadConversations().find((entry) => entry.id === id);
  if (!saved || typeof archived !== "boolean") throw new Error("找不到会话或归档状态无效。");
  const next = { ...saved, archived };
  writeConversation(next);
  if (conversation.id === id) conversation = next;
  return conversation;
});

ipcMain.handle("chat:new", (_event, workspaceId) => {
  if (turnRunning) throw new Error("请等当前消息处理完成。");
  conversation = newConversation(workspaceId);
  return conversation;
});

const pendingApprovals = new Map();

function requestApproval(sender, request) {
  if (sender.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = randomUUID();
    const finish = (approved) => {
      clearTimeout(timer);
      sender.removeListener("destroyed", cancel);
      pendingApprovals.delete(id);
      if (!sender.isDestroyed()) sender.send("chat:approval-closed", id);
      resolve(approved);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, 120_000);
    sender.once("destroyed", cancel);
    pendingApprovals.set(id, { sender, finish });
    sender.send("chat:approval", { id, ...request });
  });
}

ipcMain.handle("chat:approve", ({ sender }, { id, approved }) => {
  const entry = pendingApprovals.get(id);
  if (entry?.sender === sender) entry.finish(approved === true);
});

ipcMain.handle("chat:send", async ({ sender }, { text, mode, approvalMode }) => {
  if (conversation.archived === true) return { kind: "unavailable", text: "恢复会话后即可继续发送。" };
  const config = loadConfig();
  if (!config?.apiKey || config.apiKey === "(kept)") {
    return { kind: "need_config", text: "先连接模型：点左下角设置，填接口地址和 Key。" };
  }
  if (turnRunning) return { kind: "error", text: "上一条消息仍在处理。" };
  const input = String(text ?? "").trim();
  if (!input) return { kind: "error", text: "请输入一条消息。" };

  turnRunning = true;
  try {
    const workspace = workspaces.get(conversation.workspaceId);
    const workspaceDir = workspace?.available ? workspace.path : null;
    if (mode !== "team" && !workspaceDir) return { kind: "unavailable", text: "工作区位置不可用，请检查文件夹或磁盘。" };
    if (mode === "creator" && !await isArrodesSource(workspaceDir, app.getAppPath())) {
      return { kind: "unavailable", text: "创造模式需要在项目中打开独立的 Arrodes Git 源码副本。" };
    }
    let result;
    const executions = [];
    try {
      const run = mode === "team" ? runTeamTurn : runAgentTurn;
      result = await run({
        text: input,
        creator: mode === "creator",
        history: conversation.history.filter(({ role }) => role !== "error").slice(-12),
        workspaceDir,
        config,
        customRoles: mode === "team" ? teamRoles.list() : [],
        canvas: mode === "team" ? teamCanvases.get(conversation.workspaceId) : null,
        skills: mode === "team" ? teamSkills.list() : [],
        instructions: mode === "team" ? "" : skillInstructions(BASIC_AGENT_SKILLS),
        openItem: (path) => shell.openPath(path),
        launchDesktop: (target) => launchWindowsDesktop(target, (url) => shell.openExternal(url)),
        approveAction: (request) => approveOperation(approvalMode, request, (pending) => requestApproval(sender, pending)),
        onToolResult: (tool, outcome) => {
          if (tool === "run_powershell" && executions.length < 24) {
            executions.push({
              ok: outcome.ok, cancelled: outcome.cancelled === true,
              exitCode: outcome.exitCode ?? null, output: outcome.output,
            });
          }
        },
        onCanvasEvent: (event) => win?.webContents?.send("canvas:event", { conversationId: conversation.id, event }),
        onProgress: (line) => win?.webContents?.send("chat:progress", { line }),
      });
    } catch {
      result = { kind: "error", text: "无法连接模型，请检查网络和模型设置。" };
    }
    if (result.kind === "unavailable") return result;
    if (executions.length) result = { ...result, executions };
    saveConversation({
      ...conversation,
      history: [
        ...conversation.history,
        { role: "user", content: input },
        { role: result.kind === "error" ? "error" : "assistant", content: result.text, collaboration: result.collaboration, executions: result.executions },
      ],
    });
    return result;
  } catch {
    return { kind: "error", text: "无法访问工作区或保存会话，请检查本地目录后重试。" };
  } finally {
    turnRunning = false;
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#ffffff",
    title: "谦卑之心",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#ffffff", symbolColor: "#172033", height: 32 },
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(import.meta.dirname, "preload.cjs"),
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    try {
      appendFileSync(join(DATA_DIR, "renderer.log"), `[${level}] ${message} (${sourceId}:${lineNumber})\n`);
    } catch {}
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    try {
      appendFileSync(join(DATA_DIR, "renderer.log"), `[did-fail-load] ${code} ${desc} ${url}\n`);
    } catch {}
  });
  win.loadFile(join(import.meta.dirname, "ui", "index.html"));
}

app.whenReady().then(() => {
  workspaces.create(DEFAULT_WORKSPACE);
  conversation = loadConversations().find((entry) => entry.archived !== true) ?? newConversation(DEFAULT_WORKSPACE);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
