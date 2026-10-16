export type Status =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
/** Global reply style applied to every Dot's system prompt. */
export type ReplyStyle = 'concise' | 'standard' | 'detailed';
/** Global reply language: 'fr' pins French, 'auto' follows the user. */
export type ReplyLanguage = 'fr' | 'auto';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  /** Reply verbosity hint injected into the system prompt (default 'standard'). */
  replyStyle: ReplyStyle;
  /** Reply language hint injected into the system prompt (default 'fr'). */
  replyLanguage: ReplyLanguage;
}
/** Aggregated model usage over a window (tokens + estimated cost). */
export interface UsageSummary {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  runs: number;
}
/** Usage attributed to one Dot over the reporting window. */
export interface DotUsage extends UsageSummary {
  dotId: string;
}
/** Response of GET /api/usage. */
export interface UsageReport {
  today: UsageSummary;
  week: UsageSummary;
  byDot: DotUsage[];
}
export interface Task {
  id: string;
  prompt: string;
  status: Status;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
}
export interface Source {
  title: string;
  url: string;
  excerpt: string;
}
export interface Result {
  text: string;
  sources: Source[];
  sample: boolean;
  screenshot?: string;
}
export interface Run {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: Result | null;
  error: string | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}
export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}
export interface Detail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  mode: 'sample' | 'live';
  configured: boolean;
}
export type Action = 'run' | 'pause' | 'cancel';
export interface Space {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  /** Number of pages in the space (only set by GET /workspace). */
  pageCount?: number;
}
export interface Dot {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  createdAt: number;
  learningContainerId?: string | null;
  skillDeliveryEnabled?: boolean;
  /**
   * Per-Dot provider id (see the server provider registry); null/undefined
   * uses the server default provider.
   */
  provider?: string | null;
  /** Per-Dot model override; null/undefined uses the global default. */
  model?: string | null;
  /**
   * Reasoning effort sent to the model: 'none' disables thinking, 'low' /
   * 'medium' / 'high' enable it. null/undefined uses the model default.
   */
  reasoningEffort?: string | null;
  /**
   * Avatar id (see `AVATAR_IDS` in `./avatars`); null = identity-derived.
   */
  avatar?: string | null;
  /**
   * Budget de contexte en tokens (phase 6) : 8192/16384/32768 pour le chat
   * général ; null/undefined = Max (agentique, contexte natif maximal).
   */
  contextBudget?: number | null;
  /**
   * Stratégie de compaction (phase 9) : 'native' (défaut) ou 'magic-compact'.
   */
  compactionStrategy?: 'native' | 'magic-compact' | null;
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Last turn time; falls back to createdAt in the UI when absent. */
  updatedAt?: number | null;
  /** One-line outcome of the last turn (Muse-style activity card subtitle). */
  summary?: string | null;
  /** Frozen at creation; null means this conversation does not participate. */
  learningContainerId?: string | null;
}
export interface CallReceipt {
  anchorMessageId?: string | null;
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  transcript: string;
  error: string | null;
}
export interface SetupStatus {
  model: boolean;
  browser: boolean;
  voice: boolean;
  slack: string;
  missing: string[];
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  setup: SetupStatus;
  calls: CallReceipt[];
}
