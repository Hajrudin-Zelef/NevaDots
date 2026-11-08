// Best-effort price table for the reasoning panel's cost estimate.
// USD per 1M tokens: [input, output]. Values are indicative — adjust as needed.
// Unknown models render as "—" rather than a guessed number.
export const MODEL_PRICES_USD_PER_M: Record<string, [number, number]> = {
  'deepseek/deepseek-chat-v3-0324': [0.27, 1.1],
  // Aliases bruts exposés par la passerelle LiteLLM locale.
  'deepseek-chat': [0.27, 1.1],
  'deepseek-reasoner': [0.55, 2.19],
  'deepseek/deepseek-r1-0528': [0.55, 2.19],
  'qwen/qwen3-235b-a22b': [0.2, 0.85],
  'qwen/qwen3-max': [1.2, 6],
  'z-ai/glm-4.5': [0.6, 2.2],
  'moonshotai/kimi-k2-0905': [0.6, 2.5],
  'openai/gpt-5': [1.25, 10],
  'openai/gpt-5-mini': [0.25, 2],
  'anthropic/claude-sonnet-4.5': [3, 15],
  // Sélection OpenRouter de l'utilisateur (relevé catalogue 2026-11-08).
  'liquid/lfm-3-1.7b': [0.08, 0.2],
  'inception/mercury-3': [0.1, 0.35],
  'prism-ml/ternary-bonsai-2-9b': [0.08, 0.13],
  'inclusionai/ling-3.1-flash': [0.045, 0.135],
  'upstage/solar-mini4': [0.05, 0.2],
  'xiaomi/mimo-v2.6-flash': [0.14, 0.28],
  'qwen/qwen3.8-omni-flash': [0.15, 0.47],
  'inclusionai/ling-3.0-flash-vl': [0.06, 0.18],
  'inception/mercury-2.5': [0.04, 0.15],
  'nex-agi/nex-n2.5-pro': [0.075, 0.25],
  'meta/muse-spark-1.3-contributor': [0.1, 0.2],
  'ibm-granite/granite-4.2-8b': [0.06, 0.25],
  'z-ai/glm-5.3-flash': [0.0335, 0.083],
  'qwen/qwen3.8-flash': [0.15, 0.47],
  'nvidia/nemotron-3.5-lightning': [0.07, 0.2],
  'inclusionai/ling-3.0-tiny': [0.015, 0.045],
  'ricursiveai/ripple-65b-preview': [0.2, 0.6],
  'particle-ai/particle-1': [0.05, 0.5],
  'minimax/minimax-m3.1-flash': [0.15, 0.6],
  'deepseek/deepseek-v4.1-flash-1017': [0.006, 0.5],
  'reflection/beam-1.0-501b-a23b': [0.3, 1.0],
  'nvidia/nemotron-3.5-super-vl': [0.15, 0.5],
  'anthropic/claude-haiku-5.5': [0.1, 0.5],
  'openai/gpt-6-luna': [0.1, 0.5],
  'xiaomi/mimo-v2.6-pro': [0.435, 0.87],
  'prism-ml/ternary-bonsai-2-27b': [0.075, 0.5],
  'deepseek/deepseek-v4.1-flash': [0.051, 0.567],
  'liquid/lfm-2.5-2.6b': [0.35, 0.5],
  'upstage/solar-pro4': [0.15, 0.6],
  'tencent/hy4': [0.417, 1.2505],
  'z-ai/glm-5.3-flashx-legal': [0.37, 1.25],
  'qwen/qwen3.8-27b': [0.15, 1.875],
  'mistralai/mistral-large-4-0': [0.7, 2.1],
  'stepfun/step-5-preview': [1.0, 2.7],
  'nex-agi/nex-n2.5-mini': [0.025, 0.1],
  'meta/muse-spark-1.2-contributor': [0.1, 0.2],
  'openai/gpt-6-luna-pro': [0.1, 0.5],
  'z-ai/glm-5.3-flashx': [0.37, 1.25],
  'deepseek/deepseek-v4-flash-vision-exp': [0.44, 1.32],
  'aion-labs/aion-3.5-mini': [0.7, 1.4],
  'z-ai/glm-5.3': [0.0699, 1.4],
  'bytedance-seed/seed-2-1-turbo': [0.5, 2.5],
  'tencent/hy4-preview': [0.834, 2.501],
  'bytedance-seed/seed-2.0-code': [0.5, 3.0],
};

export function priceForModel(modelId: string): [number, number] | undefined {
  const id = modelId.toLowerCase();
  if (MODEL_PRICES_USD_PER_M[id]) return MODEL_PRICES_USD_PER_M[id];
  // Suffix match for provider-prefixed ids ("openrouter/deepseek/..." etc.).
  for (const [key, price] of Object.entries(MODEL_PRICES_USD_PER_M)) {
    if (id.endsWith(key)) return price;
  }
  return undefined;
}

/** Les tokens relus depuis le cache préfixe du provider sont massivement
 * moins chers. Facteur par défaut 0.1× (OpenAI/Anthropic) ; DeepSeek
 * facture le hit 0,07 $/1M contre 0,27 $ en miss, soit ≈ 0,26× (F6). */
export const CACHE_HIT_FACTOR = 0.1;
const CACHE_HIT_FACTOR_DEEPSEEK = 0.07 / 0.27;

export function cacheHitFactorForModel(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.includes('deepseek')) return CACHE_HIT_FACTOR_DEEPSEEK;
  return CACHE_HIT_FACTOR;
}

export function estimateCostUsd(
  modelId: string,
  promptTokens: number | null,
  completionTokens: number | null,
  cachedTokens?: number | null,
): number | null {
  if (promptTokens == null || completionTokens == null) return null;
  const price = priceForModel(modelId);
  if (!price) return null;
  const cached = Math.max(0, Math.min(cachedTokens ?? 0, promptTokens));
  return (
    ((promptTokens - cached + cached * cacheHitFactorForModel(modelId)) *
      price[0] +
      completionTokens * price[1]) /
    1_000_000
  );
}
