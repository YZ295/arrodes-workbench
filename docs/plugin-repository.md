# 插件仓库

左侧「插件仓库」提供连接插件和 Skill。连接插件让角色通过 Arrodes 使用用户本机已有的 Agent。Skill 定义如何完成某一类任务。

## 连接 Codex

1. 在本机安装 Codex CLI 并完成登录。
2. 在「插件仓库」中启用 Codex。Arrodes 在 PATH 和 Windows Codex 安装目录中查找 CLI。
3. 若需使用指定版本，填写 CLI 的绝对路径并保存。留空并保存可恢复自动检测。
4. 点击「测试连接」。该操作会向 Codex 发送一条短的模型请求。收到正确的连接码后，卡片显示「连接已验证」。
5. 点击「绑定角色」，在当前工作区的「可用角色」里配置执行器。也可以从画布上的角色入手。角色的只读或读写权限决定 Codex 使用哪种沙箱。

连接设置与验证结果保存在本机。更换 Codex 路径或停用后需要重新验证。Agent 的账号、模型和原生会话沿用其本机配置。

## 其他本机 Agent

有对应安装时会检测到连接器。也可以在启动 Arrodes 前设置以下环境变量，然后重新打开应用。检测到安装后，请在界面测试连接。

| Agent | 可选环境变量 |
| --- | --- |
| Claude Code | `ARRODES_CLAUDE_SDK`（本机 SDK 入口），`CLAUDE_CODE_EXECUTABLE`（本机 CLI） |
| DeepSeek Harness | `ARRODES_DSH_RUNTIME`（包含 `node_modules/@deepseek-ai/dsh` 的目录） |
| Hermes | `ARRODES_HERMES_SOURCE`（源码目录），`ARRODES_HERMES_PYTHON`（Python 路径） |
| OpenClaw | `ARRODES_OPENCLAW_CLI`（本机 `openclaw.mjs` 路径） |
| WorkBuddy | 实验性接入。需配置 `ARRODES_WORKBUDDY_ACP`，并使用通过连接测试的兼容 Harness |

## 投稿 Skill

把 `SKILL.md` 放在独立目录，填写 `name`、`description` 和具体操作说明。附上一句试用指令、所需工具和权限，以及可公开的示例输入与预期结果。可参考[接续项目](../arrodes/agent/skills/project-resume/SKILL.md)和下方示例。

把公开 GitHub 地址粘贴到「插件仓库 → 技能」，导入后在角色设置中启用。Skill 内容作为操作说明使用，调用工具仍走角色权限和审批。

- [接续项目示例](../examples/project-resume/README.md)
