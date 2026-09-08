export const STORE_VERSION = 2 as const;
export const PROTOCOL_VERSION = 1 as const;

export type AgentProvider = "claude" | "codex" | "opencode";
export type LlmProviderKind = "openai" | "openrouter" | "custom";
export type AppThemePreference = "light" | "dark" | "system";
export type AppLocale = "en" | "fa";
export type ChatSoundPreference = "never" | "unfocused" | "always";
export type ChatSoundId =
  | "blow"
  | "bottle"
  | "frog"
  | "funk"
  | "glass"
  | "ping"
  | "pop"
  | "purr"
  | "tink";
export type DefaultProviderPreference = "last_used" | AgentProvider;
export type ProviderProxyMode = "none" | "custom";
export type EditorPreset =
  "cursor" | "vscode" | "xcode" | "windsurf" | "custom";
export const DEFAULT_OPENAI_SDK_MODEL = "gpt-5.4-mini";
export const DEFAULT_OPENROUTER_SDK_MODEL = "moonshotai/kimi-k2.5:nitro";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_OPENCODE_MODEL = "opencode/nemotron-3.5-lightning-free";

export type AttachmentKind = "image" | "file";
export type StandaloneTranscriptAttachmentMode = "metadata" | "bundle";
export type StandaloneTranscriptTheme = "light" | "dark";

export interface SkillSearchResult {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface SkillSearchSnapshot {
  query: string;
  searchType: string;
  skills: SkillSearchResult[];
  count: number;
  duration_ms: number;
}

export interface SkillInstallResult {
  source: string;
  skillId: string;
  command: string[];
  cwd: string;
  stdout: string;
  stderr: string;
}

export interface SkillUninstallResult {
  skillId: string;
  command: string[];
  cwd: string;
  stdout: string;
  stderr: string;
}

export type SkillOperationKind = "install" | "uninstall";
export type SkillOperationStatus =
  "queued" | "running" | "succeeded" | "failed";

export interface SkillOperationSummary {
  id: string;
  kind: SkillOperationKind;
  source?: string;
  skillId: string;
  status: SkillOperationStatus;
  error?: string;
  command?: string[];
  cwd?: string;
  stdout?: string;
  stderr?: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SkillOperationsSnapshot {
  operations: SkillOperationSummary[];
}

export interface InstalledSkillSummary {
  name: string;
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  installedAt: string;
  updatedAt: string;
  pluginName?: string;
}

export interface InstalledSkillsSnapshot {
  lockFilePath: string;
  skills: InstalledSkillSummary[];
}

export interface ChatAttachment {
  id: string;
  kind: AttachmentKind;
  displayName: string;
  absolutePath: string;
  relativePath: string;
  contentUrl: string;
  mimeType: string;
  size: number;
}

export interface StandaloneTranscriptBundle {
  version: 1;
  chatId: string;
  title: string;
  localPath: string;
  exportedAt: string;
  viewerVersion: string;
  theme: StandaloneTranscriptTheme;
  attachmentMode: StandaloneTranscriptAttachmentMode;
  messages: TranscriptEntry[];
}

export interface ChatConversionPreview {
  sourceTitle: string;
  sourceProvider: string;
  targetProvider: AgentProvider;
  targetProjectId?: string;
  targetProjectTitle?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  compactBoundaries: number;
  compactSummaries: number;
  skippedEntries: number;
  importedMessageCount: number;
  pendingFork: boolean;
}

export interface QueuedChatMessage {
  id: string;
  content: string;
  attachments: ChatAttachment[];
  createdAt: number;
  provider?: AgentProvider;
  model?: string;
  modelOptions?: ModelOptions;
  planMode?: boolean;
  deliveryState?: "submitting" | "steering";
}

export interface InternalUserAttachmentsData {
  userText: string;
  attachments: ChatAttachment[];
  llmHintText: string;
}

export interface ProviderModelOption {
  id: string;
  label: string;
  supportsEffort: boolean;
  aliases?: readonly string[];
  contextWindowOptions?: readonly ProviderContextWindowOption[];
  supportsMaxReasoningEffort?: boolean;
}

export interface ProviderEffortOption {
  id: string;
  label: string;
}

export interface ProviderContextWindowOption {
  id: ClaudeContextWindow;
  label: string;
}

export const CLAUDE_REASONING_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const satisfies readonly ProviderEffortOption[];

export const CODEX_REASONING_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
] as const satisfies readonly ProviderEffortOption[];

export type ClaudeReasoningEffort =
  (typeof CLAUDE_REASONING_OPTIONS)[number]["id"];
export type CodexReasoningEffort =
  (typeof CODEX_REASONING_OPTIONS)[number]["id"];
export type CodexExecutionMode = "standard" | "dangerous";
export type ClaudeContextWindow = "200k" | "1m";
export type ServiceTier = "fast";

export interface ClaudeModelOptions {
  reasoningEffort: ClaudeReasoningEffort;
  contextWindow: ClaudeContextWindow;
}

export interface CodexModelOptions {
  reasoningEffort: CodexReasoningEffort;
  fastMode: boolean;
  executionMode?: CodexExecutionMode;
}

// OpenCode owns its provider-specific settings. Abolqasem deliberately keeps
// its first integration to model selection and native session handling.
export interface OpenCodeModelOptions {}

export interface ProviderModelOptionsByProvider {
  claude: ClaudeModelOptions;
  codex: CodexModelOptions;
  opencode: OpenCodeModelOptions;
}

export interface ProviderPreference<TModelOptions> {
  model: string;
  modelMode: "auto" | "manual";
  reasoningEffortMode: "auto" | "manual";
  modelOptions: TModelOptions;
  planMode: boolean;
}

export type ChatProviderPreferences = {
  claude: ProviderPreference<ClaudeModelOptions>;
  codex: ProviderPreference<CodexModelOptions>;
  opencode: ProviderPreference<OpenCodeModelOptions>;
};

export type ModelOptions = Partial<{
  [K in AgentProvider]: Partial<ProviderModelOptionsByProvider[K]>;
}>;

export const DEFAULT_CLAUDE_MODEL_OPTIONS = {
  reasoningEffort: "high",
  contextWindow: "200k",
} as const satisfies ClaudeModelOptions;

export const DEFAULT_CODEX_MODEL_OPTIONS = {
  reasoningEffort: "high",
  fastMode: false,
  executionMode: "dangerous",
} as const satisfies CodexModelOptions;

export const DEFAULT_OPENCODE_MODEL_OPTIONS = {} as const satisfies OpenCodeModelOptions;

export function isCodexExecutionMode(
  value: unknown,
): value is CodexExecutionMode {
  return value === "standard" || value === "dangerous";
}

export function isClaudeReasoningEffort(
  value: unknown,
): value is ClaudeReasoningEffort {
  return CLAUDE_REASONING_OPTIONS.some((option) => option.id === value);
}

export function isCodexReasoningEffort(
  value: unknown,
): value is CodexReasoningEffort {
  return CODEX_REASONING_OPTIONS.some((option) => option.id === value);
}

export const CLAUDE_CONTEXT_WINDOW_OPTIONS = [
  { id: "200k", label: "200k" },
  { id: "1m", label: "1M" },
] as const satisfies readonly ProviderContextWindowOption[];

export function isClaudeContextWindow(
  value: unknown,
): value is ClaudeContextWindow {
  return CLAUDE_CONTEXT_WINDOW_OPTIONS.some((option) => option.id === value);
}

export interface ProviderCatalogEntry {
  id: AgentProvider;
  label: string;
  available?: boolean;
  defaultModel: string;
  defaultEffort?: string;
  supportsPlanMode: boolean;
  models: ProviderModelOption[];
  efforts: ProviderEffortOption[];
}

export interface ProviderModelInventory {
  catalogModels: ProviderModelOption[];
  discoveredModels: ProviderModelOption[];
  customModels: ProviderModelOption[];
  lastRefreshAt?: string;
  lastError?: string;
}

export type ProviderModelCatalog = Record<
  AgentProvider,
  ProviderModelInventory
>;

export interface CommitMessageGeneratorSettings {
  provider: AgentProvider;
  model: string;
}

export const PROVIDERS: ProviderCatalogEntry[] = [
  {
    id: "claude",
    label: "Claude",
    defaultModel: "claude-sonnet-4-6",
    defaultEffort: "high",
    supportsPlanMode: true,
    models: [
      {
        id: "claude-opus-4-7",
        label: "Opus 4.7",
        supportsEffort: true,
        aliases: ["opus"],
        contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS],
        supportsMaxReasoningEffort: true,
      },
      {
        id: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        supportsEffort: true,
        aliases: ["sonnet"],
        contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS],
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Haiku 4.5",
        supportsEffort: true,
        aliases: ["haiku"],
      },
    ],
    efforts: [...CLAUDE_REASONING_OPTIONS],
  },
  {
    id: "codex",
    label: "Codex",
    defaultModel: DEFAULT_CODEX_MODEL,
    supportsPlanMode: true,
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: false },
      { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
      {
        id: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        supportsEffort: false,
        aliases: ["gpt-5-codex"],
      },
      {
        id: "gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        supportsEffort: false,
      },
    ],
    efforts: [],
  },
  {
    id: "opencode",
    label: "OpenCode",
    defaultModel: DEFAULT_OPENCODE_MODEL,
    supportsPlanMode: false,
    models: [
      { id: DEFAULT_OPENCODE_MODEL, label: "Nemotron 3.5 Lightning (free)", supportsEffort: false },
    ],
    efforts: [],
  },
];

export function getProviderCatalog(
  provider: AgentProvider,
): ProviderCatalogEntry {
  const entry = PROVIDERS.find((candidate) => candidate.id === provider);
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return entry;
}

function getProviderModelMatch(
  provider: AgentProvider,
  modelId?: string,
): ProviderModelOption | undefined {
  if (!modelId) return undefined;

  return getProviderCatalog(provider).models.find(
    (candidate) =>
      candidate.id === modelId || candidate.aliases?.includes(modelId),
  );
}

export function normalizeProviderModelId(
  provider: AgentProvider,
  modelId?: string,
  fallbackModelId?: string,
): string {
  const customModelId = modelId?.trim();
  return (
    getProviderModelMatch(provider, modelId)?.id ??
    (customModelId || undefined) ??
    fallbackModelId ??
    getProviderCatalog(provider).defaultModel
  );
}

export function normalizeClaudeModelId(
  modelId?: string,
  fallbackModelId = "claude-opus-4-7",
): string {
  return normalizeProviderModelId("claude", modelId, fallbackModelId);
}

export function normalizeCodexModelId(
  modelId?: string,
  fallbackModelId = DEFAULT_CODEX_MODEL,
): string {
  return normalizeProviderModelId("codex", modelId, fallbackModelId);
}

export function normalizeOpenCodeModelId(
  modelId?: string,
  fallbackModelId = DEFAULT_OPENCODE_MODEL,
): string {
  return normalizeProviderModelId("opencode", modelId, fallbackModelId);
}

export function getProviderModelOption(
  provider: AgentProvider,
  modelId: string,
): ProviderModelOption | undefined {
  const normalizedModelId = normalizeProviderModelId(provider, modelId);
  return getProviderCatalog(provider).models.find(
    (candidate) => candidate.id === normalizedModelId,
  );
}

export function getClaudeModelOption(
  modelId: string,
): ProviderModelOption | undefined {
  return getProviderModelOption("claude", modelId);
}

export function supportsClaudeMaxReasoningEffort(modelId: string): boolean {
  return Boolean(getClaudeModelOption(modelId)?.supportsMaxReasoningEffort);
}

export function getClaudeContextWindowOptions(
  modelId: string,
): readonly ProviderContextWindowOption[] {
  return getClaudeModelOption(modelId)?.contextWindowOptions ?? [];
}

export function normalizeClaudeContextWindow(
  modelId: string,
  contextWindow?: unknown,
): ClaudeContextWindow {
  const options = getClaudeContextWindowOptions(modelId);
  if (options.length === 0) return DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow;
  return options.some((option) => option.id === contextWindow)
    ? (contextWindow as ClaudeContextWindow)
    : DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow;
}

export function resolveClaudeApiModelId(
  modelId: string,
  contextWindow?: ClaudeContextWindow,
): string {
  return contextWindow === "1m" ? `${modelId}[1m]` : modelId;
}

export function resolveClaudeContextWindowTokens(
  contextWindow: ClaudeContextWindow,
): number {
  switch (contextWindow) {
    case "1m":
      return 1_000_000;
    case "200k":
    default:
      return 200_000;
  }
}

export type AbolqasemStatus =
  "idle" | "starting" | "running" | "waiting_for_user" | "failed";

export interface ProjectSummary {
  id: string;
  localPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface SidebarChatRow {
  _id: string;
  _creationTime: number;
  chatId: string;
  title: string;
  status: AbolqasemStatus;
  unread: boolean;
  localPath: string;
  provider: AgentProvider | null;
  lastMessageAt?: number;
  preview?: string;
  hasAutomation: boolean;
  canFork?: boolean;
  readOnly?: boolean;
  legacySessionKey?: string;
  pinned?: boolean;
  pinnedOrder?: number;
}

export interface SidebarProjectGroup {
  groupKey: string;
  title: string;
  realTitle: string;
  sidebarTitle?: string;
  localPath: string;
  chats: SidebarChatRow[];
  previewChats: SidebarChatRow[];
  olderChats: SidebarChatRow[];
  archivedChats?: SidebarChatRow[];
  defaultCollapsed: boolean;
}

export interface SidebarData {
  projectGroups: SidebarProjectGroup[];
}

export interface LocalProjectSummary {
  localPath: string;
  title: string;
  source: "saved" | "discovered";
  lastOpenedAt?: number;
  chatCount: number;
}

export interface LocalProjectsSnapshot {
  machine: {
    id: "local";
    displayName: string;
    platform: NodeJS.Platform;
  };
  projects: LocalProjectSummary[];
}

export interface AppSettingsSnapshot {
  browserSettingsMigrated: boolean;
  locale: AppLocale;
  theme: AppThemePreference;
  chatSoundPreference: ChatSoundPreference;
  chatSoundId: ChatSoundId;
  terminal: {
    scrollbackLines: number;
    minColumnWidth: number;
  };
  editor: {
    preset: EditorPreset;
    commandTemplate: string;
  };
  providerProxy: {
    mode: ProviderProxyMode;
    httpProxy: string;
    noProxy: string;
  };
  codexBackend: {
    mode: "native" | "manager" | "custom";
    enabled: boolean;
    managerBaseUrl: string;
    autoSwitchPolicy: "off" | "pinned" | "automatic";
    maintenance: {
      intervalSeconds: number;
      jitterSeconds: number;
      retentionDays: number;
      proxyUrl: string;
    };
    sessionMonitor: {
      enabled: boolean;
      intervalSeconds: number;
      dryRun: boolean;
      chromeRoot: string;
    };
    customProviderId: string;
    customProviders: Record<
      string,
      {
        name: string;
        baseUrl: string;
        wireApi: string;
        envKey: string;
        headers: Record<string, string>;
        models: Array<{
          id: string;
          upstreamId: string;
          displayName?: string;
          reasoningEfforts?: string[];
          inputModalities?: string[];
        }>;
        modelMap: Record<string, string>;
      }
    >;
  };
  providerExecutables: Partial<Record<AgentProvider, string>>;
  tmuxCommands: Partial<Record<AgentProvider, string>>;
  defaultProvider: DefaultProviderPreference;
  queueDeliveryMode: "queue" | "steer";
  providerDefaults: ChatProviderPreferences;
  providerModelCatalog: ProviderModelCatalog;
  commitMessageGenerator: CommitMessageGeneratorSettings;
  diskManagement?: {
    warningThresholdBytes: number;
    autoCleanup: boolean;
  };
  availableProviders: ProviderCatalogEntry[];
  management?: AppManagementSnapshot;
  warning: string | null;
  filePathDisplay: string;
}

export interface HookStatusSnapshot {
  agent: string;
  installed: boolean;
  error?: string;
}

export interface AppManagementSnapshot {
  hookNotifications: {
    enabled: boolean;
    followMode: "auto" | "notice" | "off";
    ignoreNavigationWhileTyping: boolean;
    filesystemDiscovery: boolean;
    supportedModes: Array<"auto" | "notice" | "off">;
    dangerousOperationsNeedConfirm: boolean;
  };
  service: {
    installed: boolean;
    platform: string;
  };
  hooks: HookStatusSnapshot[];
  update: UpdateSnapshot;
  actions: {
    reloadSessions: { available: boolean; requiresConfirmation: boolean };
    restartServer: { available: boolean; requiresConfirmation: boolean };
    installUpdate: { available: boolean; requiresConfirmation: boolean };
  };
}

export interface AppSettingsPatch {
  browserSettingsMigrated?: boolean;
  locale?: AppLocale;
  theme?: AppThemePreference;
  chatSoundPreference?: ChatSoundPreference;
  chatSoundId?: ChatSoundId;
  terminal?: Partial<AppSettingsSnapshot["terminal"]>;
  editor?: Partial<AppSettingsSnapshot["editor"]>;
  providerProxy?: Partial<AppSettingsSnapshot["providerProxy"]>;
  codexBackend?: Omit<
    Partial<AppSettingsSnapshot["codexBackend"]>,
    "maintenance" | "sessionMonitor"
  > & {
    maintenance?: Partial<AppSettingsSnapshot["codexBackend"]["maintenance"]>;
    sessionMonitor?: Partial<AppSettingsSnapshot["codexBackend"]["sessionMonitor"]>;
  };
  providerExecutables?: Partial<Record<AgentProvider, string>>;
  defaultProvider?: DefaultProviderPreference;
  queueDeliveryMode?: "queue" | "steer";
  providerDefaults?: {
    claude?: Partial<ProviderPreference<ClaudeModelOptions>>;
    codex?: Partial<ProviderPreference<CodexModelOptions>>;
    opencode?: Partial<ProviderPreference<OpenCodeModelOptions>>;
  };
  providerModelCatalog?: Partial<
    Record<
      AgentProvider,
      {
        catalogModels?: ProviderModelOption[];
        customModels?: ProviderModelOption[];
      }
    >
  >;
  commitMessageGenerator?: Partial<CommitMessageGeneratorSettings>;
  diskManagement?: {
    warningThresholdBytes?: number;
    autoCleanup?: boolean;
  };
}

export interface LlmProviderFile {
  provider?: LlmProviderKind;
  apiKey?: string;
  model?: string;
  baseUrl?: string | null;
}

export interface LlmProviderSnapshot {
  provider: LlmProviderKind;
  apiKey: string;
  model: string;
  baseUrl: string;
  resolvedBaseUrl: string;
  enabled: boolean;
  warning: string | null;
  filePathDisplay: string;
}

export interface LlmProviderValidationResult {
  ok: boolean;
  error: unknown | null;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "updating"
  | "restart_pending"
  | "error";

export interface UpdateSnapshot {
  currentVersion: string;
  latestVersion: string | null;
  status: UpdateStatus;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
  installAction: "restart" | "reload";
  reloadRequestedAt: number | null;
}

export type UpdateInstallErrorCode =
  "version_not_live_yet" | "install_failed" | "command_missing";

export interface UpdateInstallResult {
  ok: boolean;
  action: "restart" | "reload";
  errorCode: UpdateInstallErrorCode | null;
  userTitle: string | null;
  userMessage: string | null;
}

export type KeybindingAction =
  | "toggleEmbeddedTerminal"
  | "toggleRightSidebar"
  | "openInFinder"
  | "openInEditor"
  | "addSplitTerminal"
  | "jumpToSidebarChat"
  | "createChatInCurrentProject"
  | "openAddProject";

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string[]> = {
  toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
  toggleRightSidebar: ["cmd+b", "ctrl+b"],
  openInFinder: ["cmd+alt+f", "ctrl+alt+f"],
  openInEditor: ["cmd+shift+o", "ctrl+shift+o"],
  addSplitTerminal: ["cmd+/", "ctrl+/"],
  jumpToSidebarChat: ["cmd+alt"],
  createChatInCurrentProject: ["cmd+alt+n"],
  openAddProject: ["cmd+alt+o"],
};

export interface KeybindingsSnapshot {
  bindings: Record<KeybindingAction, string[]>;
  warning: string | null;
  filePathDisplay: string;
}

export interface McpServerInfo {
  name: string;
  status: string;
  error?: string;
}

export type McpTransport = "stdio" | "http";
export type McpProviderId = AgentProvider;

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  providers: McpProviderId[];
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpSettingsSnapshot {
  configPaths: Record<McpProviderId, string>;
  servers: McpServerConfig[];
}

export interface McpSaveResult extends McpSettingsSnapshot {
  server: McpServerConfig;
}

export interface McpRegistryInstallResult extends McpSaveResult {
  installCommand?: string[];
  cwd?: string;
  stdout?: string;
  stderr?: string;
}

export interface McpRegistrySearchResult {
  id: string;
  registryName: string;
  name: string;
  configName?: string;
  title?: string;
  description: string;
  version: string;
  status: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  installCommand?: string[];
  installable: boolean;
  installReason?: string;
  requiresConfiguration?: boolean;
  configurationNotes?: string[];
  config?: McpServerConfig;
}

export interface McpRegistrySearchSnapshot {
  query: string;
  servers: McpRegistrySearchResult[];
  count: number;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  id?: string;
  question: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export type AskUserQuestionAnswerMap = Record<string, string[]>;

export type ApprovalDecision =
  "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalRequestInput {
  approvalKind: "command_execution" | "file_change";
  itemId?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  availableDecisions?: unknown[];
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface TranscriptEntryBase {
  _id: string;
  messageId?: string;
  createdAt: number;
  hidden?: boolean;
  debugRaw?: string;
}

interface ToolCallBase<TKind extends string, TInput> {
  kind: "tool";
  toolKind: TKind;
  toolName: string;
  toolId: string;
  input: TInput;
  rawInput?: Record<string, unknown>;
}

export interface AskUserQuestionToolCall extends ToolCallBase<
  "ask_user_question",
  { questions: AskUserQuestionItem[] }
> {}

export interface ApprovalRequestToolCall extends ToolCallBase<
  "approval_request",
  ApprovalRequestInput
> {}

export interface ExitPlanModeToolCall extends ToolCallBase<
  "exit_plan_mode",
  { plan?: string; summary?: string }
> {}

export interface TodoWriteToolCall extends ToolCallBase<
  "todo_write",
  { todos: TodoItem[] }
> {}

export interface SkillToolCall extends ToolCallBase<
  "skill",
  { skill: string }
> {}

export interface GlobToolCall extends ToolCallBase<
  "glob",
  { pattern: string }
> {}

export interface GrepToolCall extends ToolCallBase<
  "grep",
  { pattern: string; outputMode?: string }
> {}

export interface BashToolCall extends ToolCallBase<
  "bash",
  {
    command: string;
    description?: string;
    timeoutMs?: number;
    runInBackground?: boolean;
  }
> {}

export interface WebSearchToolCall extends ToolCallBase<
  "web_search",
  { query: string }
> {}

export interface ReadFileToolCall extends ToolCallBase<
  "read_file",
  { filePath: string }
> {}

export interface WriteFileToolCall extends ToolCallBase<
  "write_file",
  { filePath: string; content: string }
> {}

export interface EditFileToolCall extends ToolCallBase<
  "edit_file",
  { filePath: string; oldString: string; newString: string }
> {}

export interface DeleteFileToolCall extends ToolCallBase<
  "delete_file",
  { filePath: string; content: string }
> {}

export interface SubagentTaskToolCall extends ToolCallBase<
  "subagent_task",
  { subagentType?: string }
> {}

export interface McpGenericToolCall extends ToolCallBase<
  "mcp_generic",
  { server: string; tool: string; payload: Record<string, unknown> }
> {}

export interface UnknownToolCall extends ToolCallBase<
  "unknown_tool",
  { payload: Record<string, unknown> }
> {}

export type NormalizedToolCall =
  | AskUserQuestionToolCall
  | ApprovalRequestToolCall
  | ExitPlanModeToolCall
  | TodoWriteToolCall
  | SkillToolCall
  | GlobToolCall
  | GrepToolCall
  | BashToolCall
  | WebSearchToolCall
  | ReadFileToolCall
  | WriteFileToolCall
  | EditFileToolCall
  | DeleteFileToolCall
  | SubagentTaskToolCall
  | McpGenericToolCall
  | UnknownToolCall;

export interface ToolResultEntry extends TranscriptEntryBase {
  kind: "tool_result";
  toolId: string;
  content: unknown;
  isError?: boolean;
}

export interface UserPromptEntry extends TranscriptEntryBase {
  kind: "user_prompt";
  content: string;
  attachments?: ChatAttachment[];
  steered?: boolean;
}

export interface SystemInitEntry extends TranscriptEntryBase {
  kind: "system_init";
  provider: AgentProvider;
  model: string;
  tools: string[];
  agents: string[];
  slashCommands: string[];
  mcpServers: McpServerInfo[];
}

export interface AccountInfoEntry extends TranscriptEntryBase {
  kind: "account_info";
  accountInfo: AccountInfo;
}

export interface AssistantTextEntry extends TranscriptEntryBase {
  kind: "assistant_text";
  text?: string;
  itemId?: string;
  textDelta?: string;
  status?: CodexExecutionStatus;
}

export interface ToolCallEntry extends TranscriptEntryBase {
  kind: "tool_call";
  tool: NormalizedToolCall;
}

export interface ResultEntry extends TranscriptEntryBase {
  kind: "result";
  subtype: "success" | "error" | "cancelled";
  isError: boolean;
  durationMs: number;
  result: string;
  costUsd?: number;
}

export interface StatusEntry extends TranscriptEntryBase {
  kind: "status";
  status: string;
}

export type CodexExecutionStatus =
  "inProgress" | "completed" | "failed" | "declined";

export interface CommandExecutionEntry extends TranscriptEntryBase {
  kind: "command_execution";
  itemId: string;
  command?: string;
  cwd?: string;
  status: CodexExecutionStatus;
  aggregatedOutput?: string;
  outputDelta?: string;
  exitCode?: number | null;
  durationMs?: number | null;
}

export interface CodexFileUpdateChange {
  path: string;
  kind: "add" | "delete" | "update" | string;
  diff: string;
  movedToPath?: string | null;
}

export interface FileChangeEntry extends TranscriptEntryBase {
  kind: "file_change";
  itemId: string;
  status: CodexExecutionStatus;
  changes?: CodexFileUpdateChange[];
  outputDelta?: string;
}

export interface TurnPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface TurnPlanEntry extends TranscriptEntryBase {
  kind: "turn_plan";
  turnId: string;
  explanation?: string | null;
  plan: TurnPlanStep[];
}

export interface ProposedPlanEntry extends TranscriptEntryBase {
  kind: "proposed_plan";
  turnId: string;
  plan: string;
}

export interface TurnActivityEntry extends TranscriptEntryBase {
  kind: "turn_activity";
  turnId?: string;
  activity:
    "thinking" | "running_command" | "running_mcp_tool" | "applying_changes" | "writing_response";
}

export interface ContextWindowUsageSnapshot {
  usedTokens: number;
  totalProcessedTokens?: number;
  maxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  lastUsedTokens?: number;
  lastInputTokens?: number;
  lastCachedInputTokens?: number;
  lastOutputTokens?: number;
  lastReasoningOutputTokens?: number;
  toolUses?: number;
  durationMs?: number;
  compactsAutomatically: boolean;
}

export interface RateLimitWindowSnapshot {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindowSnapshot | null;
  secondary?: RateLimitWindowSnapshot | null;
  /** All windows reported by newer app-server versions. `primary`/`secondary`
   * remain for compatibility with older transcript entries. */
  windows?: RateLimitWindowSnapshot[] | null;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string | null;
  } | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export interface ChatDiffFile {
  path: string;
  changeType: "added" | "deleted" | "modified" | "renamed";
  isUntracked: boolean;
  additions: number;
  deletions: number;
  patchDigest: string;
  mimeType?: string;
  size?: number;
}

export interface ChatBranchHistoryEntry {
  sha: string;
  summary: string;
  description: string;
  authorName?: string;
  authoredAt: string;
  tags: string[];
  githubUrl?: string;
}

export interface ChatBranchHistorySnapshot {
  entries: ChatBranchHistoryEntry[];
}

export type ChatBranchListEntryKind = "local" | "remote" | "pull_request";

export interface ChatBranchListEntry {
  id: string;
  kind: ChatBranchListEntryKind;
  name: string;
  displayName: string;
  updatedAt?: string;
  description?: string;
  remoteRef?: string;
  prNumber?: number;
  prTitle?: string;
  headRefName?: string;
  headLabel?: string;
  headRepoCloneUrl?: string;
  isCrossRepository?: boolean;
}

export interface ChatBranchListResult {
  currentBranchName?: string;
  defaultBranchName?: string;
  recent: ChatBranchListEntry[];
  local: ChatBranchListEntry[];
  remote: ChatBranchListEntry[];
  pullRequests: ChatBranchListEntry[];
  pullRequestsStatus: "available" | "unavailable" | "error";
  pullRequestsError?: string;
}

export interface GitHubPublishInfo {
  ghInstalled: boolean;
  authenticated: boolean;
  activeAccountLogin?: string;
  owners: string[];
  suggestedRepoName: string;
}

export interface GitHubRepoAvailabilityResult {
  available: boolean;
  message: string;
}

export interface BranchMetadata {
  branchName?: string;
  defaultBranchName?: string;
  hasOriginRemote?: boolean;
  originRepoSlug?: string;
  hasUpstream?: boolean;
}

export interface UpstreamStatus {
  aheadCount?: number;
  behindCount?: number;
  lastFetchedAt?: string;
}

export interface ChatDiffSnapshot extends BranchMetadata, UpstreamStatus {
  status: "unknown" | "ready" | "no_repo";
  files: ChatDiffFile[];
  warning?: string;
  branchHistory?: ChatBranchHistorySnapshot;
  checkpoints?: ChatCheckpointSummary[];
}

export type CheckpointRestoreMode = "code" | "chat" | "code_and_chat";

export interface ChatCheckpointSummary {
  id: string;
  chatId: string;
  projectId: string;
  title: string;
  createdAt: number;
  trigger: "before_user_prompt" | "before_restore" | string;
  promptPreview?: string;
  restoreOf?: string;
  codeKind: "git" | "filesystem" | "none" | string;
  codeStatus: "unknown" | "ready" | "no_repo" | string;
  codeWarning?: string;
  branchName?: string;
  commit?: string;
  fileCount?: number;
  chatMessageCount: number;
  chatRestorable: boolean;
}

export interface CheckpointRestoreResult {
  ok: boolean;
  mode: CheckpointRestoreMode;
  checkpoint: ChatCheckpointSummary;
  safetyCheckpoint: ChatCheckpointSummary;
  codeResult?: BranchActionSuccess | BranchActionFailure;
  chatRestored?: boolean;
}

export interface BranchActionSuccess {
  ok: true;
  branchName?: string;
  snapshotChanged: boolean;
}

export interface BranchActionFailure {
  ok: false;
  title: string;
  message: string;
  detail?: string;
  cancelled?: boolean;
  snapshotChanged?: boolean;
}

export type ChatSyncSuccess = BranchActionSuccess & {
  action: "fetch" | "pull" | "push" | "publish";
  aheadCount?: number;
  behindCount?: number;
};

export type ChatSyncFailure = BranchActionFailure & {
  action: "fetch" | "pull" | "push" | "publish";
};

export type ChatSyncResult = ChatSyncSuccess | ChatSyncFailure;

export type DiffCommitMode = "commit_and_push" | "commit_only";

export type ChatCheckoutBranchSuccess = BranchActionSuccess;
export type ChatCheckoutBranchFailure = BranchActionFailure;
export type ChatCheckoutBranchResult =
  ChatCheckoutBranchSuccess | ChatCheckoutBranchFailure;

export type ChatCreateBranchSuccess = BranchActionSuccess & {
  branchName: string;
};
export type ChatCreateBranchFailure = BranchActionFailure;
export type ChatCreateBranchResult =
  ChatCreateBranchSuccess | ChatCreateBranchFailure;

export type ChatMergePreviewStatus =
  "up_to_date" | "mergeable" | "conflicts" | "error";

export interface ChatMergePreviewResult {
  currentBranchName?: string;
  targetBranchName: string;
  targetDisplayName: string;
  status: ChatMergePreviewStatus;
  commitCount: number;
  hasConflicts: boolean;
  message: string;
  detail?: string;
}

export type ChatMergeBranchSuccess = BranchActionSuccess;
export type ChatMergeBranchFailure = BranchActionFailure;
export type ChatMergeBranchResult =
  ChatMergeBranchSuccess | ChatMergeBranchFailure;

export type DiffCommitSuccess = BranchActionSuccess & {
  mode: DiffCommitMode;
  pushed: boolean;
};

export type DiffCommitFailure = BranchActionFailure & {
  mode: DiffCommitMode;
  phase: "commit" | "push";
  localCommitCreated?: boolean;
};

export type DiffCommitResult = DiffCommitSuccess | DiffCommitFailure;

export interface ContextWindowUpdatedEntry extends TranscriptEntryBase {
  kind: "context_window_updated";
  usage: ContextWindowUsageSnapshot;
}

export interface RateLimitUpdatedEntry extends TranscriptEntryBase {
  kind: "rate_limit_updated";
  rateLimits: RateLimitSnapshot;
}

export interface CompactBoundaryEntry extends TranscriptEntryBase {
  kind: "compact_boundary";
}

export interface CompactSummaryEntry extends TranscriptEntryBase {
  kind: "compact_summary";
  summary: string;
}

export interface ContextClearedEntry extends TranscriptEntryBase {
  kind: "context_cleared";
}

export interface InterruptedEntry extends TranscriptEntryBase {
  kind: "interrupted";
}

export interface ModelChangeEntry extends TranscriptEntryBase {
  kind: "model_change";
  model?: string;
  reasoningEffort?: string;
}

export type TranscriptEntry =
  | UserPromptEntry
  | SystemInitEntry
  | AccountInfoEntry
  | AssistantTextEntry
  | ToolCallEntry
  | ToolResultEntry
  | ResultEntry
  | StatusEntry
  | CommandExecutionEntry
  | FileChangeEntry
  | TurnPlanEntry
  | ProposedPlanEntry
  | TurnActivityEntry
  | ContextWindowUpdatedEntry
  | RateLimitUpdatedEntry
  | CompactBoundaryEntry
  | CompactSummaryEntry
  | ContextClearedEntry
  | InterruptedEntry
  | ModelChangeEntry;

export interface HydratedToolCallBase<TKind extends string, TInput, TResult> {
  id: string;
  messageId?: string;
  hidden?: boolean;
  kind: "tool";
  toolKind: TKind;
  toolName: string;
  toolId: string;
  input: TInput;
  result?: TResult;
  rawResult?: unknown;
  isError?: boolean;
  timestamp: string;
}

export interface AskUserQuestionToolResult {
  answers: AskUserQuestionAnswerMap;
  discarded?: boolean;
}

export interface ApprovalRequestToolResult {
  decision: ApprovalDecision;
}

export interface ExitPlanModeToolResult {
  confirmed?: boolean;
  clearContext?: boolean;
  message?: string;
  discarded?: boolean;
}

export type HydratedAskUserQuestionToolCall = HydratedToolCallBase<
  "ask_user_question",
  AskUserQuestionToolCall["input"],
  AskUserQuestionToolResult
>;

export type HydratedApprovalRequestToolCall = HydratedToolCallBase<
  "approval_request",
  ApprovalRequestToolCall["input"],
  ApprovalRequestToolResult
>;

export type HydratedExitPlanModeToolCall = HydratedToolCallBase<
  "exit_plan_mode",
  ExitPlanModeToolCall["input"],
  ExitPlanModeToolResult
>;

export type HydratedTodoWriteToolCall = HydratedToolCallBase<
  "todo_write",
  TodoWriteToolCall["input"],
  unknown
>;

export type HydratedSkillToolCall = HydratedToolCallBase<
  "skill",
  SkillToolCall["input"],
  unknown
>;

export type HydratedGlobToolCall = HydratedToolCallBase<
  "glob",
  GlobToolCall["input"],
  unknown
>;

export type HydratedGrepToolCall = HydratedToolCallBase<
  "grep",
  GrepToolCall["input"],
  unknown
>;

export type HydratedBashToolCall = HydratedToolCallBase<
  "bash",
  BashToolCall["input"],
  unknown
>;

export type HydratedWebSearchToolCall = HydratedToolCallBase<
  "web_search",
  WebSearchToolCall["input"],
  unknown
>;

export interface ReadFileTextBlock {
  type: "text";
  text: string;
}

export interface ReadFileImageBlock {
  type: "image";
  data: string;
  mimeType?: string;
}

export interface ReadFileToolResult {
  content: string;
  blocks?: Array<ReadFileTextBlock | ReadFileImageBlock>;
}

export type HydratedReadFileToolCall = HydratedToolCallBase<
  "read_file",
  ReadFileToolCall["input"],
  ReadFileToolResult | string
>;

export type HydratedWriteFileToolCall = HydratedToolCallBase<
  "write_file",
  WriteFileToolCall["input"],
  unknown
>;

export type HydratedEditFileToolCall = HydratedToolCallBase<
  "edit_file",
  EditFileToolCall["input"],
  unknown
>;

export type HydratedDeleteFileToolCall = HydratedToolCallBase<
  "delete_file",
  DeleteFileToolCall["input"],
  unknown
>;

export type HydratedSubagentTaskToolCall = HydratedToolCallBase<
  "subagent_task",
  SubagentTaskToolCall["input"],
  unknown
>;

export type HydratedMcpGenericToolCall = HydratedToolCallBase<
  "mcp_generic",
  McpGenericToolCall["input"],
  unknown
>;

export type HydratedUnknownToolCall = HydratedToolCallBase<
  "unknown_tool",
  UnknownToolCall["input"],
  unknown
>;

export type HydratedToolCall =
  | HydratedAskUserQuestionToolCall
  | HydratedApprovalRequestToolCall
  | HydratedExitPlanModeToolCall
  | HydratedTodoWriteToolCall
  | HydratedSkillToolCall
  | HydratedGlobToolCall
  | HydratedGrepToolCall
  | HydratedBashToolCall
  | HydratedWebSearchToolCall
  | HydratedReadFileToolCall
  | HydratedWriteFileToolCall
  | HydratedEditFileToolCall
  | HydratedDeleteFileToolCall
  | HydratedSubagentTaskToolCall
  | HydratedMcpGenericToolCall
  | HydratedUnknownToolCall;

export type HydratedTranscriptMessage =
  | {
      kind: "user_prompt";
      content: string;
      attachments?: ChatAttachment[];
      steered?: boolean;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "system_init";
      model: string;
      tools: string[];
      agents: string[];
      slashCommands: string[];
      mcpServers: McpServerInfo[];
      provider: AgentProvider;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
      debugRaw?: string;
    }
  | {
      kind: "account_info";
      accountInfo: AccountInfo;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "assistant_text";
      text: string;
      itemId?: string;
      status?: CodexExecutionStatus;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "result";
      success: boolean;
      cancelled?: boolean;
      result: string;
      durationMs: number;
      costUsd?: number;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "status";
      status: string;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "command_execution";
      itemId: string;
      command: string;
      cwd: string;
      status: CodexExecutionStatus;
      aggregatedOutput: string;
      exitCode?: number | null;
      durationMs?: number | null;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "file_change";
      itemId: string;
      status: CodexExecutionStatus;
      changes: CodexFileUpdateChange[];
      output: string;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "turn_plan";
      turnId: string;
      explanation?: string | null;
      plan: TurnPlanStep[];
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "proposed_plan";
      turnId: string;
      plan: string;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "turn_activity";
      turnId?: string;
      activity: TurnActivityEntry["activity"];
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "model_change";
      model?: string;
      reasoningEffort?: string;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "context_window_updated";
      usage: ContextWindowUsageSnapshot;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "rate_limit_updated";
      rateLimits: RateLimitSnapshot;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "compact_boundary";
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "compact_summary";
      summary: string;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "context_cleared";
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "interrupted";
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | {
      kind: "unknown";
      json: string;
      id: string;
      messageId?: string;
      timestamp: string;
      hidden?: boolean;
    }
  | ({ id: string; messageId?: string; hidden?: boolean } & HydratedToolCall);

export interface ChatRuntime {
  chatId: string;
  projectId: string;
  localPath: string;
  title: string;
  status: AbolqasemStatus;
  turnStartedAt?: number;
  isDraining: boolean;
  provider: AgentProvider | null;
  planMode: boolean;
  sessionToken: string | null;
  pendingForkSessionToken?: string | null;
  readOnly?: boolean;
  legacySessionKey?: string;
  tmuxSession?: string;
  tmuxCommand?: string;
  tmuxActive?: boolean;
  nativeSessionId?: string;
  nativeTranscriptPath?: string;
  parentChatId?: string;
  lastSummary?: string;
  codexLock?: CodexLockStatus;
}

export type CodexLockState =
  "available" | "owned_by_us" | "owned_elsewhere" | "unknown";

export interface CodexLockStatus {
  state: CodexLockState;
  sessionId?: string;
  sessionPath?: string;
  ownerPid?: number;
  ownerCommand?: string;
  otherWritableSessions?: number;
  executionMode?: CodexExecutionMode;
  canTakeOver: boolean;
  canRelease: boolean;
  message?: string;
}

export type TranscriptIndexRole = "user" | "assistant" | "system" | "tool";

export interface TranscriptIndexItem {
  id: string;
  sequence: number;
  role: TranscriptIndexRole;
  estimatedHeight?: number;
  hasError?: boolean;
  hasCode?: boolean;
  isPinned?: boolean;
  preview?: string;
}

export interface ChatTranscriptIndexSnapshot {
  chatId: string;
  items: TranscriptIndexItem[];
}

export interface ChatHistorySnapshot {
  hasOlder: boolean;
  olderCursor: string | null;
  recentLimit: number;
}

export interface ChatSnapshot {
  runtime: ChatRuntime;
  queuedMessages: QueuedChatMessage[];
  messages: TranscriptEntry[];
  history: ChatHistorySnapshot;
  availableProviders: ProviderCatalogEntry[];
}

export interface ChatHistoryPage {
  messages: TranscriptEntry[];
  hasOlder: boolean;
  olderCursor: string | null;
  targetFound?: boolean;
}

export interface AbolqasemSnapshot {
  sidebar: SidebarData;
  chat?: ChatSnapshot | null;
}

export interface PendingToolSnapshot {
  toolUseId: string;
  toolKind: "ask_user_question" | "exit_plan_mode";
}
