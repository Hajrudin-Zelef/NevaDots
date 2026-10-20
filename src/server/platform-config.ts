import type { WebConfig } from './parallel.js';
import type { ProviderConfig, ProviderRegistry } from './providers.js';
import type { ExternalAccounts } from './external-accounts.js';
import type { SetupStatus } from '../shared/types.js';

export interface PlatformConfig extends WebConfig {
  /** SQLite file shared by the stores and the durable transcript runner. */
  databasePath?: string;
  /** Default model for the default provider. */
  model?: string;
  /** Selectable model ids of the default provider; falls back to [model]. */
  models?: string[];
  /** Model context window in tokens, used for automatic compaction. */
  contextWindow?: number;
  /** Max output tokens per completion. Too low truncates tool arguments
   * mid-JSON (large files); default 8192, env MAX_COMPLETION_TOKENS. */
  maxCompletionTokens?: number;
  apiKey?: string;
  baseUrl: string;
  /** Model providers the agent can use (OpenCode, OpenRouter, DeepSeek…). */
  providers?: ProviderConfig[];
  /** Mutable registry backing `providers`; owns keys, models and the default. */
  providerRegistry?: ProviderRegistry;
  /** External service accounts (GitHub…) with encrypted tokens. */
  externalAccounts?: ExternalAccounts;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack,
    missing,
  };
}
