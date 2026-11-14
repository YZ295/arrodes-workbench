import { deepSeekModelId } from "./deepseek.mjs";
import { requestModel } from "./loop.mjs";

export function normalizeModelAddress(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function resolveModelConnection(draft, saved) {
  const baseUrl = normalizeModelAddress(draft?.baseUrl);
  if (!baseUrl) return { error: "请输入有效的 HTTP 或 HTTPS 接口地址，例如 https://api.openai.com/v1。" };

  const sameAddress = baseUrl === normalizeModelAddress(saved?.baseUrl);
  const apiKey = String(draft?.apiKey ?? "").trim() || (sameAddress ? saved?.apiKey : "");
  if (!apiKey || apiKey === "(kept)") return { error: "请为当前接口地址填写 API Key。" };
  return { baseUrl, apiKey, modelId: deepSeekModelId(baseUrl, String(draft?.modelId ?? "").trim()) };
}

function statusError(status, fallback) {
  if (status === 401 || status === 403) return "接口拒绝了请求，请检查 API Key 和模型权限。";
  if (status === 429) return "请求受到限流，请稍后重试。";
  return status ? `${fallback}（HTTP ${status}）。` : `${fallback}。`;
}

export async function listAvailableModels(config) {
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if ([404, 405, 501].includes(response.status)) return { error: "接口未提供模型列表，可手动填写模型后测试连接。" };
    if (!response.ok) return { error: statusError(response.status, "未能获取模型列表") };
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.data)) return { error: "接口未返回兼容的模型列表，可手动填写模型后测试连接。" };
    const models = [...new Set(body.data.flatMap((item) => {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      return id ? [id] : [];
    }))].sort((a, b) => a.localeCompare(b));
    return { models };
  } catch {
    return { error: "无法获取模型列表，请检查接口地址、网络或超时设置。" };
  }
}

export async function testModelConnection(config) {
  if (!config.modelId) return { error: "请先选择或填写模型。" };
  try {
    const { message, status } = await requestModel(config, [
      { role: "user", content: "Reply with OK." },
    ], [], { timeoutMs: 15000, maxTokens: 256 });
    if (typeof message?.content === "string" && message.content.trim()) return { ok: true };
    return { error: statusError(status, "该模型未返回可用的对话回复，请检查模型 ID、权限或余额") };
  } catch {
    return { error: "无法测试连接，请检查接口地址、网络或超时设置。" };
  }
}
