// CommonJS preload：Electron 的 sandbox 环境只支持 CJS preload，
// 用 ESM（.mjs）会导致 window.arrodes 未注入 → 首屏白屏。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("arrodes", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  listModels: (config) => ipcRenderer.invoke("config:listModels", config),
  testModel: (config) => ipcRenderer.invoke("config:testModel", config),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  listWorkspaces: () => ipcRenderer.invoke("workspaces:list"),
  createWorkspace: (name, location) => ipcRenderer.invoke("workspaces:create", name, location),
  chooseWorkspaceParent: () => ipcRenderer.invoke("workspaces:chooseParent"),
  attachWorkspace: () => ipcRenderer.invoke("workspaces:attach"),
  openWorkspace: (name) => ipcRenderer.invoke("workspaces:open", name),
  getConversation: () => ipcRenderer.invoke("chat:get"),
  getTeamRoles: () => ipcRenderer.invoke("chat:roles"),
  createTeamRole: (role) => ipcRenderer.invoke("chat:createRole", role),
  getCanvas: (workspaceId) => ipcRenderer.invoke("canvas:get", workspaceId),
  saveCanvas: (workspaceId, graph) => ipcRenderer.invoke("canvas:save", workspaceId, graph),
  importTeamSkill: () => ipcRenderer.invoke("canvas:importSkill"),
  importGithubSkill: (link) => ipcRenderer.invoke("canvas:importGithubSkill", link),
  canvasArtifact: (workspaceId, ref, reveal) => ipcRenderer.invoke("canvas:artifact", workspaceId, ref, reveal),
  onCanvasEvent: (callback) => ipcRenderer.on("canvas:event", (_event, payload) => callback(payload)),
  listConversations: () => ipcRenderer.invoke("chat:list"),
  openConversation: (id) => ipcRenderer.invoke("chat:open", id),
  archiveConversation: (id, archived) => ipcRenderer.invoke("chat:archive", id, archived),
  newConversation: (workspaceName) => ipcRenderer.invoke("chat:new", workspaceName),
  send: (payload) => ipcRenderer.invoke("chat:send", payload),
  approve: (payload) => ipcRenderer.invoke("chat:approve", payload),
  onApproval: (callback) => ipcRenderer.on("chat:approval", (_event, payload) => callback(payload)),
  onApprovalClosed: (callback) => ipcRenderer.on("chat:approval-closed", (_event, id) => callback(id)),
  onProgress: (callback) => ipcRenderer.on("chat:progress", (_event, payload) => callback(payload)),
});
