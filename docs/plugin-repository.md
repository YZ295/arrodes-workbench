# 插件市场

打开左侧「插件市场」。「发现」页提供搜索、分类和安装。「已安装」显示从市场安装的技能与主题。「Agent 预设」管理本机执行器检测、测试和角色绑定。

应用先显示随包提供的内容，再读取 GitHub 社区目录。断网时可继续使用已经安装的功能和随包条目。安装技能后，按需要将它启用给角色。安装主题后点击「应用」，也可以在同一个卡片恢复默认。

卡片的「查看来源」会显示发布路径。目录提供更高版本时，可手动更新，已有的角色绑定继续使用当前技能。卸载仍被角色或画布使用的技能时，应用会先列出引用，用户可确认解除绑定并卸载。

主题会同时更新应用内容和原生窗口按钮区域。重启后，窗口使用上次应用的主题。

## 连接 Codex

1. 在本机安装 Codex CLI 并完成登录。
2. 在「插件市场 → Agent 预设」中启用 Codex。Arrodes 在 PATH 和 Windows Codex 安装目录中查找 CLI。
3. 若需使用指定版本，填写 CLI 的绝对路径并保存。留空并保存可恢复自动检测。
4. 点击「测试连接」。该操作会向 Codex 发送一条短的模型请求。收到正确的连接码后，卡片显示「连接已验证」。
5. 点击「绑定角色」，在当前工作区的「可用角色」里配置执行器。也可以从画布上的角色入手。角色的只读或读写权限决定 Codex 使用哪种沙箱。

连接设置与验证结果保存在本机。更换 Codex 路径或停用后需要重新验证。Agent 的账号、模型和原生会话沿用其本机配置。

## 其他本机 Agent

有对应安装时会检测到连接器。也可以在启动 Arrodes 前设置以下环境变量，然后重新打开应用。检测到安装后，请在界面测试连接。

卡片显示「未检测到」时，请先确认原生运行入口已安装或配置。通过连接测试后才会显示角色绑定。WorkBuddy 需要兼容的 Harness 入口，仅安装桌面客户端无法确认连接。

WorkBuddy 的连接测试区分协议握手、原生会话、模型回复及角色权限模式。测试四项都满足后才允许绑定。

| Agent | 可选环境变量 |
| --- | --- |
| Claude Code | `ARRODES_CLAUDE_SDK`（本机 SDK 入口），`CLAUDE_CODE_EXECUTABLE`（本机 CLI） |
| DeepSeek Harness | `ARRODES_DSH_RUNTIME`（包含 `node_modules/@deepseek-ai/dsh` 的目录） |
| Hermes | `ARRODES_HERMES_SOURCE`（源码目录），`ARRODES_HERMES_PYTHON`（Python 路径） |
| OpenClaw | `ARRODES_OPENCLAW_CLI`（本机 `openclaw.mjs` 路径） |
| WorkBuddy | 实验性接入。需配置 `ARRODES_WORKBUDDY_ACP`，并使用通过连接测试的兼容 Harness |

## 投稿 Skill

把 `SKILL.md` 放在独立目录，填写 `name`、`description` 和具体操作说明。附上一句试用指令、所需工具和权限，以及可公开的示例输入与预期结果。可参考[接续项目](../arrodes/agent/skills/project-resume/SKILL.md)和下方示例。

在「插件市场 → 发现」展开「从 GitHub 地址导入」，可以先测试自己的公开 Skill。要进入发现列表，向[社区目录](../arrodes/agent/marketplace/catalog.json)提交条目，填写 ID、分类、名称、描述、作者、版本与公开 `SKILL.md` 链接，条目类型填 `skill` 并标记 `distribution: remote`。市场会通过现有的 GitHub 导入器读取正文。Skill 调用工具仍受角色权限和审批约束。

- [接续项目示例](../examples/project-resume/README.md)
