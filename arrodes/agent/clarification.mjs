import { randomUUID } from "node:crypto";

const paths = {
  type: "array", items: { type: "string" }, maxItems: 16,
};
export const clarificationSchema = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: { type: "array", maxItems: 4, items: {
      type: "object",
      properties: {
        label: { type: "string" }, task: { type: "string" }, inputs: paths, outputs: paths,
      },
      required: ["label", "task", "inputs", "outputs"],
    } },
  },
  required: ["question", "options"],
};
export const clarificationTool = { type: "function", function: {
  name: "ask_user",
  description: "仅在执行确实缺少用户决定时暂停。给出一个具体问题及最多四个可执行选项；缺的是一个值时 options 为空，由用户填写。每个选项包含具体任务、源文件和交付路径。",
  parameters: clarificationSchema,
} };

export function validateClarification(value) {
  const clean = (item, limit) => typeof item === "string" && item.trim().length <= limit ? item.trim() : "";
  const question = clean(value?.question, 600);
  if (!question || !Array.isArray(value.options) || value.options.length > 4) throw new Error("请提供确认问题和选项。");
  const options = value.options.map((item) => {
    const label = clean(item?.label, 100);
    const task = clean(item?.task, 2500);
    for (const list of [item?.inputs, item?.outputs]) {
      if (!Array.isArray(list) || list.length > 16 || list.some((path) => !clean(path, 260))) throw new Error("请明确输入与输出。");
    }
    if (!label || !task) throw new Error("每个选项都需要名称和具体任务。");
    return { label, task, inputs: item.inputs.map((path) => path.trim()), outputs: item.outputs.map((path) => path.trim()) };
  });
  if (new Set(options.map(({ label }) => label)).size !== options.length) throw new Error("请使用互不重复的选项名称。");
  return { question, options };
}

export function pendingClarification(result, mode, goal) {
  return { ...result, id: randomUUID(), mode, goal };
}

export function resolveClarification(pending, text, control) {
  if (control?.id !== undefined && pending?.id !== control.id) throw new Error("该确认已失效，请查看当前会话。");
  if (!pending) return null;
  if (control?.cancel === true || /^(取消|不用了|先不做了)[。！!]?$/u.test(text)) return { cancelled: true };
  const normalized = text.normalize("NFKC").trim().replace(/[。！!]+$/u, "");
  const ordinal = pending.options.length ? /^(?:选|方案|选项|第)?\s*([1-4一二三四])\s*(?:项|个)?$/u.exec(normalized)?.[1] : undefined;
  const implicitIndex = ordinal ? ("1234".includes(ordinal) ? Number(ordinal) - 1 : "一二三四".indexOf(ordinal)) : undefined;
  const index = control?.index ?? implicitIndex;
  const option = index === undefined ? pending.options.find(({ label }) => label.normalize("NFKC") === normalized) : pending.options[index];
  if (index !== undefined && (!Number.isInteger(index) || !option)) throw new Error("请选择确认卡片中已有的选项。");
  const supplement = /^补充\s*[：:]\s*([\s\S]+)$/u.exec(text)?.[1]?.trim();
  if (!option && !supplement) return null;
  return {
    mode: pending.mode,
    text: `${pending.goal}\n已回答的确认问题：${pending.question}\n${option
      ? `已选方案：${option.label}\n任务：${option.task}\n源文件：${JSON.stringify(option.inputs)}\n交付路径：${JSON.stringify(option.outputs)}`
      : `用户补充：${supplement}`}`,
  };
}
