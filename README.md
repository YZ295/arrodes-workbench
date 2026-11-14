# Arrodes · 多智能体协作编排与调度平台

Arrodes（谦卑之心）是 Windows 桌面 Agent 工作台。可以在选定的工作区对话和处理文件，也可以创建专用 Agent，为各角色独立配置 Skill，在画布上安排协作并查看实际交接和验收。

## 使用

在「Releases」下载 Arrodes1.0.1.exe 和同版本 SHA-256 文件。便携包未签名。运行后打开左下角「设置」，配置 OpenAI 兼容的服务地址、API Key 和模型，测试连接后选择工作区。进入「多 Agent」可创建角色、导入和绑定 Skill、连线并交办任务。

1.0.1 的本地工具支持列目录、读写文本和检查 JavaScript 语法。Skill 为模型提供操作说明，工具调用仍受角色授权约束。使用云模型时，对话和部分工具读取内容可能发给配置的模型服务。

## 从源码运行

Windows x64 和 Node.js 24。

```powershell
npm ci
npm test
npm start
```

桌面回归运行 npm run test:desktop。运行 npm run build:portable 构建便携包，产物位于 arrodes/release/。

公开源码基于参赛仓库的桌面发行版 1.0.1（6c2b6cb96af58bbf4ecbbb0c9990ec4b5abcc5df）。公开版提取桌面源码、协作运行时和所需错误契约，并提供独立构建入口。Release 的 EXE 沿用原始发行二进制；新构建的文件摘要可能不同。

项目采用 [Apache-2.0](LICENSE)，随包 Markdown 渲染器的许可证和来源见 [vendor 目录](arrodes/ui/vendor/markdown-it/)。
