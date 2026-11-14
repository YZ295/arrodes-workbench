export const DEEPSEEK_API = "https://api.deepseek.com";
export const DEEPSEEK_FLASH = "deepseek-flash";

export function isDeepSeekApi(baseUrl) {
  return /^https:\/\/api\.deepseek\.com(?::443)?(?:\/v1)?\/?$/i.test(baseUrl);
}

export function deepSeekModelId(baseUrl, modelId) {
  if (isDeepSeekApi(baseUrl) && (!modelId || modelId === "deepseek-chat")) {
    return DEEPSEEK_FLASH;
  }
  return modelId;
}
