import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { execFile } from "node:child_process";
import { DEEPSEEK_FLASH, deepSeekModelId, isDeepSeekApi } from "./deepseek.mjs";

/**
 * 模型 + 工具循环——这就是内核。
 * 模型自己决定：直接回答、读文件、写文件、还是先看目录。
 * 没有意图分类、没有图、没有调度器。
 */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出工作区的文件和目录",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取工作区内一个文本文件的内容",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对工作区的路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或覆盖工作区内一个文本文件（content 必须是完整内容）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区的路径" },
          content: { type: "string", description: "完整文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_syntax",
      description: "对工作区内一个 .js/.mjs/.cjs 文件运行 node --check 做语法检查",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对工作区的路径" } },
        required: ["path"],
      },
    },
  },
];

export const WORKSPACE_TOOL_NAMES = TOOLS.map(({ function: tool }) => tool.name);
const ASSIST_TOOL = {
  type: "function",
  function: {
    name: "request_assist",
    description: "缺少当前任务所需的材料或业务口径时，向协调者请求协助。",
    parameters: {
      type: "object",
      properties: { needs: { type: "string" }, missingInput: { type: "string" }, expected: { type: "string" } },
      required: ["needs", "missingInput", "expected"],
    },
  },
};

export function safePath(workspaceDir, requested) {
  const base = resolve(workspaceDir);
  const target = resolve(base, requested);
  const rel = relative(base, target);
  const outside = () => new Error(`路径越界：${requested} 不在工作区内`);
  if (isAbsolute(requested) || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !rel) {
    throw outside();
  }
  for (let path = target; path !== base; path = dirname(path)) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) continue;
    const resolved = relative(realpathSync(base), realpathSync(path));
    if (isAbsolute(resolved) || resolved === ".." || resolved.startsWith(`..${sep}`)) throw outside();
    break;
  }
  return target;
}

function executeTool(name, args, workspaceDir) {
  switch (name) {
    case "list_dir": {
      const walk = (dir, depth) => {
        if (depth > 2) return [];
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
        const out = [];
        for (const entry of entries.slice(0, 40)) {
          if (entry.name.startsWith(".")) continue;
          const full = join(dir, entry.name);
          out.push(entry.isDirectory() ? `[目录] ${entry.name}/` : `${entry.name}（${existsSync(full) ? "可读" : "?"}）`);
          if (entry.isDirectory()) out.push(...walk(full, depth + 1));
        }
        return out;
      };
      return { ok: true, output: walk(workspaceDir, 0).join("\n") || "（空工作区）" };
    }
    case "read_file": {
      const target = safePath(workspaceDir, String(args.path ?? ""));
      if (!existsSync(target)) return { ok: false, output: "文件不存在" };
      return { ok: true, output: readFileSync(target, "utf8").slice(0, 8000) };
    }
    case "write_file": {
      const target = safePath(workspaceDir, String(args.path ?? ""));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, String(args.content ?? ""), "utf8");
      return { ok: true, output: `已写入 ${args.path}（${String(args.content ?? "").length} 字符）` };
    }
    case "check_syntax": {
      const target = safePath(workspaceDir, String(args.path ?? ""));
      return new Promise((resolvePromise) => {
        execFile(process.env.AEW_NODE ?? process.execPath, ["--check", target], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 15_000,
          windowsHide: true,
        }, (error, _stdout, stderr) => {
          resolvePromise({
            ok: !error,
            output: (error ? stderr || String(error) : "语法检查通过").slice(0, 2000),
          });
        });
      });
    }
    default:
      return { ok: false, output: `未知工具 ${name}` };
  }
}

export const APP_CAPABILITY_BOUNDARIES = "应用能力与对话权限：多 Agent 可协调已配置的角色。对话不能创建或修改角色、安装或分配 Skill、改画布连线；这些操作由用户在界面完成。问「你能不能直接做」时，先用第一人称说明你是否有执行权限。回答其他能力问题时，以本轮实际提供的工具为准。";

const SYSTEM = `你是「谦卑之心」，一个 Windows 桌面 Agent。用户在对话框里说话，你可以使用工作区工具完成实际任务。

${APP_CAPABILITY_BOUNDARIES}

行为准则：
- 打招呼、提问、闲聊：直接回答，不要调用工具。问工作区在哪里时，使用下面提供的实际目录。
- 用户取消或说先不做时，直接确认并结束本轮，不要调用工具。
- 交办任务：先用 list_dir 看工作区，再按需要 read_file / write_file，写完代码类文件用 check_syntax 验证，然后向用户报告改了什么、检查结果如何。
- 用户请你拟角色或接受上一轮的草拟邀请：根据对话给出名称、职责和建议权限，不要调用工具。说明当前工具不能实现的用途，不要宣称创建了角色。
- 目标不清：先问一个具体问题，不要瞎猜着执行。
- 回复始终是简体中文，简短、直接、说人话。
- 你做的事要真实：文件真的会写入磁盘，检查真的会执行，不要假装完成。`;

export async function requestModel(config, messages, tools = [], { timeoutMs = 90000, maxTokens = 3000 } = {}) {
  const model = deepSeekModelId(config.baseUrl, config.modelId);
  const officialFlash = model === DEEPSEEK_FLASH && isDeepSeekApi(config.baseUrl);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model, temperature: 0.3, max_tokens: maxTokens, messages,
      ...(officialFlash ? { thinking: { type: "disabled" } } : {}),
      ...(tools.length ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return { status: response.status, error: response.status === 401 || response.status === 403
      ? "模型服务拒绝了连接，请检查 API Key 和模型权限。"
      : "模型服务暂时无法完成请求，请检查设置或稍后重试。" };
  }
  const body = await response.json();
  const message = body.choices?.[0]?.message;
  return message ? { message } : { error: "模型返回为空" };
}

export async function verifyWorkspaceFile(workspaceDir, path) {
  try {
    const read = executeTool("read_file", { path }, workspaceDir);
    if (!read.ok) return read;
    if (/\.(js|mjs|cjs)$/i.test(path)) return await executeTool("check_syntax", { path }, workspaceDir);
    return { ok: true, output: "文件可读" };
  } catch {
    return { ok: false, output: "无法读取或验证文件" };
  }
}

export async function runAgentTurn({ text, history, workspaceDir, config, onProgress, collaboration }) {
  const tools = collaboration ? TOOLS.filter(({ function: tool }) => collaboration.tools.includes(tool.name)) : TOOLS;
  const allowed = new Set(tools.map(({ function: tool }) => tool.name));
  const activeTools = collaboration?.onAssist ? [...tools, ASSIST_TOOL] : tools;
  const role = collaboration ? `协作阶段：${collaboration.stage}\n${collaboration.instructions}\n` : "";
  const messages = [
    { role: "system", content: `${role}${SYSTEM}\n当前工作区目录：${workspaceDir}` },
    ...history.map((item) => ({ role: item.role, content: item.content })),
    { role: "user", content: text },
  ];

  for (let step = 0; step < 8; step += 1) {
    const { message, error } = await requestModel(config, messages, activeTools);
    if (error) return { kind: "error", text: error };

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      messages.push(message);
      for (const call of message.tool_calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments ?? "{}");
        } catch {
          args = {};
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
        if (name === "request_assist" && collaboration?.onAssist &&
          [args.needs, args.missingInput, args.expected].every((value) => typeof value === "string" && value.trim())) {
          collaboration.onAssist(args);
        }
        onProgress?.(`调用工具 ${name}`);
        let result;
        try {
          result = allowed.has(name) ? await executeTool(name, args, workspaceDir) : { ok: false, output: "工具不可用或参数无效" };
        } catch (error) {
          result = { ok: false, output: error?.message ?? String(error) };
        }
        collaboration?.onToolResult?.(name, args, result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
      continue;
    }

    const content = message.content?.trim();
    if (!content) return { kind: "error", text: "模型返回了空回复" };
    return { kind: "reply", text: content };
  }

  return { kind: "error", text: "工具调用轮次过多，已停止。" };
}
