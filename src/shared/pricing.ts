// Best-effort price table for the reasoning panel's cost estimate.
// USD per 1M tokens: [input, output]. Values are indicative — adjust as needed.
// Unknown models render as "—" rather than a guessed number.
export const MODEL_PRICES_USD_PER_M: Record<string, [number, number]> = {
  'deepseek/deepseek-chat-v3-0324': [0.27, 1.1],
  'deepseek/deepseek-r1-0528': [0.55, 2.19],
  'qwen/qwen3-235b-a22b': [0.2, 0.85],
  'qwen/qwen3-max': [1.2, 6],
  'z-ai/glm-4.5': [0.6, 2.2],
  'moonshotai/kimi-k2-0905': [0.6, 2.5],
  'openai/gpt-5': [1.25, 10],
  'openai/gpt-5-mini': [0.25, 2],
  'anthropic/claude-sonnet-4.5': [3, 15],
};

export function priceForModel(
  modelId: string,
): [number, number] | undefined {
  const id = modelId.toLowerCase();
  if (MODEL_PRICES_USD_PER_M[id]) return MODEL_PRICES_USD_PER_M[id];
  // Suffix match for provider-prefixed ids ("openrouter/deepseek/..." etc.).
  for (const [key, price] of Object.entries(MODEL_PRICES_USD_PER_M)) {
    if (id.endsWith(key)) return price;
  }
  return undefined;
}

export function estimateCostUsd(
  modelId: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (promptTokens == null || completionTokens == null) return null;
  const price = priceForModel(modelId);
  if (!price) return null;
  return (
    (promptTokens * price[0] + completionTokens * price[1]) / 1_000_000
  );
}
