# Arrodes · 多智能体协作编排与调度平台

Arrodes（谦卑之心）是 Windows 桌面 Agent 工作台。可以在选定的工作区对话和处理文件，也可以创建专用 Agent，为各角色独立配置 Skill，在画布上安排协作并查看实际交接和验收。

## 使用

从 [GitHub Releases](https://github.com/YZ295/arrodes-workbench/releases/latest) 下载 Windows x64 便携版和同版本 SHA-256 文件。便携包未签名。运行后打开左下角「设置」，配置 OpenAI 兼容的服务地址、API Key 和模型，测试连接后选择工作区。进入「多 Agent」可创建角色、导入和绑定 Skill、连线并交办任务。

Arrodes 支持工作区文件、文档、表格、网页搜索与多 Agent 协作。Skill 为模型提供操作说明，工具调用仍受角色授权约束。使用云模型时，对话和部分工具读取内容可能发给配置的模型服务。

### 插件市场

从左侧打开「插件市场」。在「发现」页搜索并安装技能或主题，在「已安装」页查看已添加的功能。社区目录由 GitHub 维护。「Agent 预设」提供 Codex 等本地 Agent 的检测、连接和角色绑定。

也可在发现页粘贴公开 GitHub 仓库、目录或 `SKILL.md` 地址。安装的技能可在角色的 Skill 设置中启用。详见[连接配置与社区投稿说明](docs/plugin-repository.md)。

## 从源码运行

Windows x64 和 Node.js 24。

```powershell
npm ci
npm test
npm start
```

桌面回归运行 npm run test:desktop。运行 npm run build:portable 构建便携包，产物位于 arrodes/release/。

公开源码基于参赛仓库的桌面发行版 1.0.1（6c2b6cb96af58bbf4ecbbb0c9990ec4b5abcc5df）。公开版提取桌面源码、协作运行时和所需错误契约，并提供独立构建入口。1.0.1 的 Release 保留原始发行二进制，1.1.0 由公开仓库源码构建。

项目采用 [Apache-2.0](LICENSE)，随包 Markdown 渲染器的许可证和来源见 [vendor 目录](arrodes/ui/vendor/markdown-it/)。

## 基础 Skill

Arrodes 在普通对话提供基础 Skill，在「多 Agent」中可分别绑定给各角色。只读角色可以检索、读取、统计和验收。这些操作按输入框旁选择的批准档位执行。

- 搜索文件名与文本内容、比较两个文件、预览并归档。
- 读取 Markdown、DOCX 和带文字层的 PDF，返回行号、段落号或页码。
- 读取 CSV、TSV 和 XLSX，计算指定列汇总，生成新 XLSX，核对指定单元格。
- 验收文件可读性与支持的格式，检查 JavaScript 语法。
- 搜索并编辑项目代码，运行选定的 JavaScript 测试文件。
- 按关键词搜索公开网页和 GitHub 仓库，阅读搜索结果并返回来源，打开工作区文件或目录，或启动默认浏览器、回收站、资源管理器、记事本、计算器和 Windows 设置。

文档暂不包含扫描件 OCR。Excel 读取已有公式缓存值。网页关键词发送给 Bing，仓库关键词发送给 GitHub。网页搜索结果受服务可用性影响，网页读取适用于公开静态页面。运行测试脚本使用本机账户权限，确认框会显示命令和路径。

Windows PowerShell 可在普通对话及多 Agent 的读写执行角色中调用。需要确认时，应用会显示完整脚本和工作目录。脚本使用当前 Windows 用户权限。每次运行限 60 秒，应用返回输出和退出码。

## 批准权限与创造模式

- **请求批准**（默认）：需要确认的操作逐次询问。
- **帮我批准**：自动打开常用应用和工作区项目，PowerShell、批量移动及源码改动仍需确认。
- **完全访问权限**：现有工具跳过确认弹窗。只读角色的工具范围依然有效。重启应用后恢复默认。

创造模式在普通对话输入框旁开启。先选择一份独立的 Arrodes Git 源码副本，再交办改动。按当前批准档位应用文件差异。修改后需手动构建、重启。
