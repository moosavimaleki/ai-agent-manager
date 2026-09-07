import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  BookText,
  Command,
  Code,
  ExternalLink,
  Info,
  Gauge,
  Loader2,
  Menu,
  MessageSquareQuote,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SquarePen,
  LogOut,
  Trash2,
  X,
} from "lucide-react";
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { getKeybindingsFilePathDisplay } from "../../shared/branding";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  PROVIDERS,
  type AppLocale,
  type AppSettingsSnapshot,
  type AppSettingsPatch,
  type AgentProvider,
  type InstalledSkillSummary,
  type KeybindingAction,
  type LlmProviderKind,
  type ProviderProxyMode,
  type InstalledSkillsSnapshot,
  type SkillInstallResult,
  type SkillOperationSummary,
  type SkillOperationsSnapshot,
  type SkillSearchResult,
  type SkillSearchSnapshot,
  type SkillUninstallResult,
  type McpProviderId,
  type McpRegistryInstallResult,
  type McpRegistrySearchResult,
  type McpRegistrySearchSnapshot,
  type McpSaveResult,
  type McpServerConfig,
  type McpSettingsSnapshot,
  type McpTransport,
  type ProviderCatalogEntry,
  type ProviderModelOption,
  type UpdateSnapshot,
} from "../../shared/types";
import { ChatPreferenceControls } from "../components/chat-ui/ChatPreferenceControls";
import { EDITOR_OPTIONS, EditorIcon } from "../components/editor-icons";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { Input } from "../components/ui/input";
import { SettingsHeaderButton } from "../components/ui/settings-header-button";
import type { EditorPreset } from "../../shared/protocol";
import { SegmentedControl } from "../components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  KEYBINDING_ACTION_LABELS,
  formatKeybindingInput,
  getResolvedKeybindings,
  parseKeybindingInput,
} from "../lib/keybindings";
import { playChatNotificationSound } from "../lib/chatSounds";
import { cn } from "../lib/utils";
import {
  DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_MIN_COLUMN_WIDTH,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_MIN_COLUMN_WIDTH,
  MIN_TERMINAL_SCROLLBACK,
  getDefaultEditorCommandTemplate,
  useTerminalPreferencesStore,
} from "../stores/terminalPreferencesStore";
import { useChatPreferencesStore } from "../stores/chatPreferencesStore";
import {
  CHAT_SOUND_OPTIONS,
  useChatSoundPreferencesStore,
  type ChatSoundId,
  type ChatSoundPreference,
} from "../stores/chatSoundPreferencesStore";
import type { AbolqasemState } from "./useAbolqasemState";
import {
  getDictionary,
  getLocaleDirection,
  LOCALE_OPTIONS,
  normalizeLocale,
} from "../i18n";
import { useI18n } from "../i18n/context";
import { HOOK_NOTIFICATION_SETTINGS_HASH, settingsRoute } from "./routes";
import { UsageSettingsSection } from "./UsageSettingsSection";
import { ChangelogSection } from "../components/settings/ChangelogSection";
import {
  SettingsInfoHint,
  SettingsRow,
} from "../components/settings/SettingsPrimitives";
import { useAppSettingsStore } from "../stores/appSettingsStore";
import { CustomProviderEditor } from "../components/settings/CustomProviderEditor";
import { DeviceLoginDialog } from "../components/codex-manager/DeviceLoginDialog";
import { AccountsPanel } from "../components/codex-manager/AccountsPanel";
import { BrowserSessionsPanel } from "../components/codex-manager/BrowserSessionsPanel";
import { UsageHistoryChart } from "../components/codex-manager/UsageHistoryChart";

type TelegramCustomCommandDraft = {
  name: string;
  description: string;
  command: string;
  workingDirectory: string;
  timeoutSeconds: number;
};

type CodexManagerTab =
  "accounts" | "load-balancer" | "chrome" | "charts" | "advanced";

type CodexManagerGatewaySnapshot = {
  enabled: boolean;
  mode: "native" | "manager" | "custom";
  managerBaseUrl: string;
  autoSwitchPolicy: "off" | "pinned" | "automatic";
  gateway?: { state?: string; lastError?: string; crashCount?: number };
  diagnostics?: {
    store?: { ready?: boolean; message?: string };
    liveAuth?: { present?: boolean; message?: string };
    gatewayKeyConfigured?: boolean;
    worker?: {
      running?: boolean;
      nextRun?: string;
      lastRun?: string;
      lastError?: string;
    };
    sessionMonitor?: {
      enabled?: boolean;
      running?: boolean;
      dryRun?: boolean;
      nextRun?: string;
      lastRun?: string;
      lastError?: string;
      profilesChecked?: number;
      accountsChecked?: number;
      targets?: number;
      revoked?: number;
    };
  };
};

export function validateTelegramCustomCommandDrafts(
  commands: TelegramCustomCommandDraft[],
  locale: AppLocale,
): string | null {
  const seen = new Set<string>();
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    const name = command.name.trim().toLowerCase();
    const systemCommand = command.command.trim();
    if (!name && !systemCommand) continue;
    const prefix =
      locale === "fa" ? `فرمان ${index + 1}` : `Command ${index + 1}`;
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
      return locale === "fa"
        ? `${prefix}: نام باید فقط حروف کوچک انگلیسی، عدد، _ یا - باشد.`
        : `${prefix}: name may only contain lowercase letters, numbers, _ or -.`;
    }
    if (!systemCommand) {
      return locale === "fa"
        ? `${prefix}: فرمان سیستم را وارد کنید.`
        : `${prefix}: enter the system command.`;
    }
    if (seen.has(name)) {
      return locale === "fa"
        ? `${prefix}: نام فرمان تکراری است.`
        : `${prefix}: command name is duplicated.`;
    }
    seen.add(name);
  }
  return null;
}

const sidebarItems = [
  {
    id: "general",
    label: "General",
    icon: Settings2,
    subtitle:
      "Manage appearance, editor behavior, and embedded terminal defaults.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: BookText,
    subtitle:
      "Manage globally installed agent skills from the active skill lock file.",
  },
  {
    id: "mcp",
    label: "MCP",
    icon: Server,
    subtitle: "Manage shared MCP servers for Codex and Claude Code.",
  },
  {
    id: "codex-manager",
    label: "Codex Manager",
    icon: Gauge,
    subtitle:
      "Manage Codex accounts, automatic switching, limits, and browser sessions.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: MessageSquareQuote,
    subtitle:
      "Manage the default chat provider and saved model defaults for Claude Code and Codex.",
  },
  {
    id: "proxy",
    label: "Proxy",
    icon: Network,
    subtitle:
      "Control proxy environment variables for Claude Code and Codex runs.",
  },
  {
    id: "telegram",
    label: "Telegram",
    icon: MessageSquareQuote,
    subtitle: "Connect an allowlisted Telegram bot to existing Codex chats.",
  },
  {
    id: "usage",
    label: "Usage",
    icon: Gauge,
    subtitle: "Review Codex limits and local cache usage.",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: Command,
    subtitle:
      "Edit global app shortcuts stored in the active keybindings file.",
  },
  // always last
  {
    id: "changelog",
    label: "Changelog",
    icon: BookText,
    subtitle: "Release notes pulled from the public GitHub releases feed.",
  },
] as const;
type SidebarItem = (typeof sidebarItems)[number];
type SidebarPageId = SidebarItem["id"];

export function resolveSettingsSectionId(
  sectionId: string | undefined,
): SidebarPageId | null {
  if (!sectionId) return null;
  return sidebarItems.some((item) => item.id === sectionId)
    ? (sectionId as SidebarPageId)
    : null;
}

const QUICK_RESPONSE_PROVIDER_OPTIONS: Array<{
  value: LlmProviderKind;
  label: string;
}> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
];

const AGENT_PROVIDER_IDS: AgentProvider[] = ["claude", "codex", "opencode"];

type ModelCatalogDrafts = Record<AgentProvider, ProviderModelOption[]>;
type NewModelCatalogDrafts = Record<
  AgentProvider,
  { id: string; label: string }
>;

function emptyModelCatalogDrafts(): ModelCatalogDrafts {
  return { claude: [], codex: [], opencode: [] };
}

function emptyNewModelCatalogDrafts(): NewModelCatalogDrafts {
  return {
    claude: { id: "", label: "" },
    codex: { id: "", label: "" },
    opencode: { id: "", label: "" },
  };
}

function cloneProviderModelOption(
  model: ProviderModelOption,
): ProviderModelOption {
  return {
    ...model,
    aliases: model.aliases ? [...model.aliases] : undefined,
    contextWindowOptions: model.contextWindowOptions
      ? model.contextWindowOptions.map((option) => ({ ...option }))
      : undefined,
  };
}

function cloneProviderModelOptions(
  models: ProviderModelOption[],
): ProviderModelOption[] {
  return models.map(cloneProviderModelOption);
}

function findProviderCatalogEntry(
  availableProviders: ProviderCatalogEntry[],
  provider: AgentProvider,
): ProviderCatalogEntry {
  return (
    availableProviders.find((candidate) => candidate.id === provider) ??
    PROVIDERS.find((candidate) => candidate.id === provider) ??
    PROVIDERS[0]
  );
}

function normalizeEditableProviderModels(
  provider: AgentProvider,
  models: ProviderModelOption[],
): ProviderModelOption[] {
  const seen = new Set<string>();
  const normalized: ProviderModelOption[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      ...cloneProviderModelOption(model),
      id,
      label: model.label.trim() || id,
      supportsEffort: model.supportsEffort || provider === "claude",
    });
  }
  return normalized;
}

export function providerModelCatalogResetPatch(
  provider: AgentProvider,
): AppSettingsPatch {
  return {
    providerModelCatalog: {
      [provider]: { catalogModels: [], customModels: [] },
    },
  };
}

export function providerModelCatalogRemoval(
  provider: AgentProvider,
  modelId: string,
  models: ProviderModelOption[],
  selectedModel: string,
): { models: ProviderModelOption[]; patch: AppSettingsPatch } | null {
  const current = normalizeEditableProviderModels(provider, models);
  if (current.length <= 1) return null;
  const nextModels = current.filter((model) => model.id !== modelId);
  if (nextModels.length === current.length) return null;
  const nextDefaultModel = selectedModel === modelId ? nextModels[0].id : null;
  return {
    models: nextModels,
    patch: {
      providerModelCatalog: {
        [provider]: { catalogModels: nextModels, customModels: [] },
      },
      ...(nextDefaultModel
        ? {
            providerDefaults: { [provider]: { model: nextDefaultModel } },
          }
        : {}),
    },
  };
}

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/moosavimaleki/abolqasem/releases";
const CHANGELOG_CACHE_TTL_MS = 5 * 60 * 1000;

type GithubRelease = {
  id: number;
  name: string | null;
  tag_name: string;
  html_url: string;
  published_at: string | null;
  body: string | null;
  prerelease: boolean;
  draft: boolean;
};

type ChangelogStatus = "idle" | "loading" | "success" | "error";

type ChangelogCache = {
  expiresAt: number;
  releases: GithubRelease[];
};

type FetchReleases = (input: string, init?: RequestInit) => Promise<Response>;

let changelogCache: ChangelogCache | null = null;
const KEYBINDING_ACTIONS = Object.keys(
  KEYBINDING_ACTION_LABELS,
) as KeybindingAction[];

export function getKeybindingsSubtitle(filePathDisplay: string) {
  return `Edit global app shortcuts stored in ${filePathDisplay}.`;
}

export function shouldPreviewChatSoundChange(
  previousValue: string,
  nextValue: string,
) {
  return previousValue !== nextValue;
}

export function canSendTelegramTest(
  status: { configured?: boolean; knownChats?: number } | null,
) {
  return status?.configured === true && (status.knownChats ?? 0) > 0;
}

export function resetSettingsPageChangelogCache() {
  changelogCache = null;
}

export async function fetchGithubReleases(
  fetchImpl: FetchReleases = fetch,
): Promise<GithubRelease[]> {
  const response = await fetchImpl(GITHUB_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub releases request failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as GithubRelease[];
  return payload.filter((release) => !release.draft);
}

export function getCachedChangelog() {
  if (!changelogCache) return null;
  if (Date.now() >= changelogCache.expiresAt) {
    changelogCache = null;
    return null;
  }
  return changelogCache.releases;
}

export function setCachedChangelog(releases: GithubRelease[]) {
  changelogCache = {
    releases,
    expiresAt: Date.now() + CHANGELOG_CACHE_TTL_MS,
  };
}

export function isChangelogReleaseNewer(
  latest: string | null | undefined,
  current: string | null | undefined,
) {
  const latestVersion = normalizeVersionForComparison(latest);
  const currentVersion = normalizeVersionForComparison(current);
  if (!latestVersion || !currentVersion || latestVersion === currentVersion)
    return false;
  if (isDevelopmentVersion(currentVersion)) return true;

  const [latestBase, latestPrerelease] = splitVersionPrerelease(latestVersion);
  const [currentBase, currentPrerelease] =
    splitVersionPrerelease(currentVersion);
  const versionComparison = compareDottedVersion(latestBase, currentBase);
  if (versionComparison > 0) return true;
  if (versionComparison < 0) return false;
  return currentPrerelease.length > 0 && latestPrerelease.length === 0;
}

export function resolveSettingsAppVersion(
  updateSnapshot: UpdateSnapshot | null | undefined,
  appSettings: Pick<AppSettingsSnapshot, "management"> | null | undefined,
) {
  const version =
    updateSnapshot?.currentVersion?.trim() ||
    appSettings?.management?.update?.currentVersion?.trim();
  return version || "unknown";
}

function normalizeVersionForComparison(version: string | null | undefined) {
  return (version ?? "").trim().replace(/^v/i, "");
}

function isDevelopmentVersion(version: string) {
  const normalized = version.trim().toLowerCase();
  return normalized === "dev" || normalized.startsWith("dev-");
}

function splitVersionPrerelease(version: string): [string, string] {
  const [base, prerelease = ""] = version.trim().split("-", 2);
  return [base.trim(), prerelease.trim()];
}

function compareDottedVersion(left: string, right: string) {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const maxParts = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxParts; index += 1) {
    const leftValue = versionPart(leftParts[index]);
    const rightValue = versionPart(rightParts[index]);
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function versionPart(part: string | undefined) {
  const trimmed = (part ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  return Number.parseInt(trimmed, 10);
}

export async function loadChangelog(options?: {
  force?: boolean;
  fetchImpl?: FetchReleases;
}) {
  const cached = options?.force ? null : getCachedChangelog();
  if (cached) {
    return cached;
  }

  const releases = await fetchGithubReleases(options?.fetchImpl);
  setCachedChangelog(releases);
  return releases;
}

export function formatPublishedDate(value: string | null) {
  if (!value) return "Unpublished";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown date";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

export {
  ChangelogSection,
  type ChangelogStatus,
  type GithubRelease,
} from "../components/settings/ChangelogSection";

function formatInstallCount(count: number) {
  if (!count || count <= 0) return "0 installs";
  if (count >= 1_000_000)
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000)
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function SkillErrorBlock({ message }: { message: string }) {
  return (
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {message}
    </pre>
  );
}

function isActiveSkillOperation(operation: SkillOperationSummary | undefined) {
  return operation?.status === "queued" || operation?.status === "running";
}

function skillOperationSortValue(operation: SkillOperationSummary) {
  const value =
    operation.finishedAt || operation.startedAt || operation.enqueuedAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function newerSkillOperation(
  current: SkillOperationSummary | undefined,
  next: SkillOperationSummary,
) {
  if (!current) return next;
  if (isActiveSkillOperation(next) && !isActiveSkillOperation(current))
    return next;
  if (!isActiveSkillOperation(next) && isActiveSkillOperation(current))
    return current;
  return skillOperationSortValue(next) >= skillOperationSortValue(current)
    ? next
    : current;
}

function installOperationKey(source: string | undefined, skillId: string) {
  return `install:${source || ""}:${skillId}`;
}

function uninstallOperationKey(skillId: string) {
  return `uninstall:${skillId}`;
}

function skillOperationIdentityKey(operation: SkillOperationSummary) {
  return operation.kind === "install"
    ? installOperationKey(operation.source, operation.skillId)
    : uninstallOperationKey(operation.skillId);
}

function indexSkillOperations(operations: SkillOperationSummary[]) {
  return operations.reduce<Record<string, SkillOperationSummary>>(
    (indexed, operation) => {
      indexed[operation.id] = operation;
      return indexed;
    },
    {},
  );
}

function mergeSkillOperations(
  current: Record<string, SkillOperationSummary>,
  backendOperations: SkillOperationSummary[],
) {
  const next = indexSkillOperations(backendOperations);
  const backendKeys = new Set(backendOperations.map(skillOperationIdentityKey));

  for (const operation of Object.values(current)) {
    if (!operation.id.startsWith("local-")) continue;
    if (backendKeys.has(skillOperationIdentityKey(operation))) continue;
    next[operation.id] = operation;
  }
  return next;
}

function latestInstallOperationByKey(operations: SkillOperationSummary[]) {
  const indexed = new Map<string, SkillOperationSummary>();
  for (const operation of operations) {
    if (operation.kind !== "install") continue;
    const key = installOperationKey(operation.source, operation.skillId);
    indexed.set(key, newerSkillOperation(indexed.get(key), operation));
  }
  return indexed;
}

function latestUninstallOperationByKey(operations: SkillOperationSummary[]) {
  const indexed = new Map<string, SkillOperationSummary>();
  for (const operation of operations) {
    if (operation.kind !== "uninstall") continue;
    const key = uninstallOperationKey(operation.skillId);
    indexed.set(key, newerSkillOperation(indexed.get(key), operation));
  }
  return indexed;
}

function InstalledSkillCard({
  skill,
  operation,
  onUninstall,
}: {
  skill: InstalledSkillSummary;
  operation?: SkillOperationSummary;
  onUninstall: () => void;
}) {
  const { t } = useI18n();
  const href = skill.source
    ? `https://skills.sh/${skill.source}/${skill.name}`
    : null;
  const uninstalling = isActiveSkillOperation(operation);
  const statusMessage =
    operation?.status === "queued"
      ? t.settings.queued
      : operation?.status === "running"
        ? t.settings.uninstalling
        : operation?.status === "failed"
          ? operation.error || t.settings.uninstallFailed
          : null;

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-card/30 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {skill.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {skill.source || "Unknown source"}
        </div>
        {statusMessage ? (
          <div
            className={cn(
              "mt-1 truncate text-xs",
              operation?.status === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {statusMessage}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`View ${skill.name} on skills.sh`}
            className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : null}
        <button
          type="button"
          aria-label={`Uninstall ${skill.name}`}
          disabled={uninstalling}
          onClick={onUninstall}
          className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
        >
          {uninstalling ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}

function SkillResultCard({
  skill,
  operation,
  installed,
  message,
  onInstall,
}: {
  skill: SkillSearchResult;
  operation?: SkillOperationSummary;
  installed: boolean;
  message?: string;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const installing = isActiveSkillOperation(operation);
  const statusMessage =
    operation?.status === "queued"
      ? t.settings.installQueued
      : operation?.status === "running"
        ? t.settings.installing
        : operation?.status === "failed" && !installed
          ? operation.error || t.settings.installFailed
          : installed && message
            ? message
            : null;
  const statusTone =
    operation?.status === "failed" && !installed
      ? "text-destructive"
      : installed
        ? "text-emerald-500"
        : "text-muted-foreground";

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-card/30 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {skill.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {skill.source} · {formatInstallCount(skill.installs)}
        </div>
        {statusMessage ? (
          <div className={cn("mt-1 truncate text-xs", statusTone)}>
            {statusMessage}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a
          href={`https://skills.sh/${skill.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${skill.name} on skills.sh`}
          className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <Button
          type="button"
          size="sm"
          variant={installed ? "secondary" : "default"}
          disabled={installing || installed}
          onClick={onInstall}
          className="h-6 rounded-full px-2 text-xs"
        >
          {installing ? (
            <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {installed
            ? t.settings.installed
            : operation?.status === "queued"
              ? t.settings.queued
              : installing
                ? t.settings.installing
                : t.settings.get}
        </Button>
      </div>
    </div>
  );
}

export function SkillsSection({
  state,
}: {
  state: Pick<AbolqasemState, "connectionStatus" | "socket">;
}) {
  const { t } = useI18n();
  const socket = state.socket;
  const connectionStatus = state.connectionStatus;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installedSkills, setInstalledSkills] = useState<
    InstalledSkillSummary[]
  >([]);
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [installedLoading, setInstalledLoading] = useState(false);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [skillOperations, setSkillOperations] = useState<
    Record<string, SkillOperationSummary>
  >({});
  const [installMessages, setInstallMessages] = useState<
    Record<string, string>
  >({});

  const operationList = useMemo(
    () => Object.values(skillOperations),
    [skillOperations],
  );
  const installOperations = useMemo(
    () => latestInstallOperationByKey(operationList),
    [operationList],
  );
  const uninstallOperations = useMemo(
    () => latestUninstallOperationByKey(operationList),
    [operationList],
  );
  const hasActiveSkillOperations = operationList.some(isActiveSkillOperation);

  async function loadInstalledSkills(options?: { quiet?: boolean }) {
    if (connectionStatus !== "connected") {
      setInstalledSkills([]);
      setInstalledSkillIds(new Set());
      setInstalledError(null);
      if (!options?.quiet) {
        setInstalledLoading(false);
      }
      return;
    }

    try {
      if (!options?.quiet) {
        setInstalledLoading(true);
      }
      setInstalledError(null);
      const snapshot = await socket.command<InstalledSkillsSnapshot>({
        type: "skills.listInstalled",
      });
      setInstalledSkills(snapshot.skills);
      setInstalledSkillIds(new Set(snapshot.skills.map((skill) => skill.name)));
    } catch (error) {
      if (options?.quiet) {
        return;
      }
      setInstalledSkills([]);
      setInstalledSkillIds(new Set());
      setInstalledError(
        error instanceof Error
          ? error.message
          : t.settings.unableReadInstalledSkills,
      );
    } finally {
      if (!options?.quiet) {
        setInstalledLoading(false);
      }
    }
  }

  async function loadSkillOperations() {
    if (connectionStatus !== "connected") {
      setSkillOperations({});
      return;
    }

    try {
      const snapshot = await socket.command<SkillOperationsSnapshot>({
        type: "skills.listOperations",
      });
      setSkillOperations((current) =>
        mergeSkillOperations(current, snapshot.operations),
      );
    } catch {
      // Operation polling is supportive UI; command-level errors still surface per action.
    }
  }

  useEffect(() => {
    void loadInstalledSkills();
    void loadSkillOperations();
  }, [connectionStatus, socket]);

  useEffect(() => {
    if (connectionStatus !== "connected" || !hasActiveSkillOperations) return;

    const interval = window.setInterval(() => {
      void loadSkillOperations();
      void loadInstalledSkills({ quiet: true });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [connectionStatus, hasActiveSkillOperations, socket]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    if (connectionStatus !== "connected") {
      setResults([]);
      setSearchLoading(false);
      setSearchError(t.settings.backendConnectionRequired);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);

    const timeout = window.setTimeout(() => {
      void socket
        .command<SkillSearchSnapshot>({
          type: "skills.search",
          query: normalizedQuery,
          limit: 100,
        })
        .then((snapshot) => {
          if (cancelled) return;
          setResults(snapshot.skills);
        })
        .catch((error) => {
          if (cancelled) return;
          setResults([]);
          setSearchError(
            error instanceof Error
              ? error.message
              : t.settings.unableSearchSkills,
          );
        })
        .finally(() => {
          if (cancelled) return;
          setSearchLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [connectionStatus, query, socket]);

  async function installSkill(skill: SkillSearchResult) {
    if (connectionStatus !== "connected") {
      setOperationError(t.settings.backendConnectionRequired);
      return;
    }

    const localOperationId = `local-install-${skill.source}-${skill.skillId}-${Date.now()}`;
    const localOperation: SkillOperationSummary = {
      id: localOperationId,
      kind: "install",
      source: skill.source,
      skillId: skill.skillId,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
    };

    try {
      setSkillOperations((current) => ({
        ...current,
        [localOperationId]: localOperation,
      }));
      setOperationError(null);
      setInstallMessages((current) => {
        const next = { ...current };
        delete next[skill.id];
        return next;
      });
      await socket.command<SkillInstallResult>({
        type: "skills.install",
        source: skill.source,
        skillId: skill.skillId,
      });
      setInstalledSkillIds((current) => new Set(current).add(skill.skillId));
      setInstallMessages((current) => ({
        ...current,
        [skill.id]: t.settings.installedGlobally,
      }));
      await Promise.all([
        loadInstalledSkills({ quiet: true }),
        loadSkillOperations(),
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t.settings.installFailed;
      setOperationError(message);
      setSkillOperations((current) => ({
        ...current,
        [localOperationId]: {
          ...localOperation,
          status: "failed",
          error: message,
          finishedAt: new Date().toISOString(),
        },
      }));
      void loadSkillOperations();
    }
  }

  async function uninstallSkill(skill: InstalledSkillSummary) {
    if (connectionStatus !== "connected") {
      setOperationError(t.settings.backendConnectionRequired);
      return;
    }

    const localOperationId = `local-uninstall-${skill.name}-${Date.now()}`;
    const localOperation: SkillOperationSummary = {
      id: localOperationId,
      kind: "uninstall",
      skillId: skill.name,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
    };

    try {
      setSkillOperations((current) => ({
        ...current,
        [localOperationId]: localOperation,
      }));
      setOperationError(null);
      await socket.command<SkillUninstallResult>({
        type: "skills.uninstall",
        skillId: skill.name,
      });
      setInstalledSkills((current) =>
        current.filter((installedSkill) => installedSkill.name !== skill.name),
      );
      setInstalledSkillIds((current) => {
        const next = new Set(current);
        next.delete(skill.name);
        return next;
      });
      setInstallMessages((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) {
          if (key.endsWith(`/${skill.name}`) || key === skill.name) {
            delete next[key];
          }
        }
        return next;
      });
      await Promise.all([
        loadInstalledSkills({ quiet: true }),
        loadSkillOperations(),
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t.settings.uninstallFailed;
      setOperationError(message);
      setSkillOperations((current) => ({
        ...current,
        [localOperationId]: {
          ...localOperation,
          status: "failed",
          error: message,
          finishedAt: new Date().toISOString(),
        },
      }));
      void loadSkillOperations();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {operationError ? <SkillErrorBlock message={operationError} /> : null}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">
            {t.settings.installed}
          </div>
          {installedLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        {installedError ? (
          <div className="text-xs text-destructive">{installedError}</div>
        ) : null}
        {installedSkills.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {installedSkills.map((skill) => (
              <InstalledSkillCard
                key={`${skill.source}/${skill.name}`}
                skill={skill}
                operation={uninstallOperations.get(
                  uninstallOperationKey(skill.name),
                )}
                onUninstall={() => {
                  void uninstallSkill(skill);
                }}
              />
            ))}
          </div>
        ) : !installedLoading ? (
          <div className="rounded-lg border border-border bg-card/30 p-3 text-sm text-muted-foreground">
            {t.settings.noGlobalSkillsInstalled}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">
          {t.settings.discover}
        </div>
        <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card/30 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.settings.searchSkills}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <button
              type="button"
              aria-label={t.settings.clearSkillsSearch}
              onClick={() => setQuery("")}
              className="touch-manipulation inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {searchLoading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        {searchError ? (
          <div className="text-xs text-destructive">{searchError}</div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          {results.map((skill) => (
            <SkillResultCard
              key={skill.id}
              skill={skill}
              operation={installOperations.get(
                installOperationKey(skill.source, skill.skillId),
              )}
              installed={installedSkillIds.has(skill.skillId)}
              message={installMessages[skill.id]}
              onInstall={() => {
                void installSkill(skill);
              }}
            />
          ))}
        </div>
        {!searchLoading &&
        !searchError &&
        query.trim().length >= 2 &&
        results.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/30 p-3 text-sm text-muted-foreground">
            {t.settings.noSkillsFound}
          </div>
        ) : null}
      </section>
    </div>
  );
}

const MCP_PROVIDER_OPTIONS: Array<{ id: McpProviderId; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
];

type McpFormState = {
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  envText: string;
  headersText: string;
  providers: McpProviderId[];
};

function emptyMcpForm(): McpFormState {
  return {
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    url: "",
    envText: "",
    headersText: "",
    providers: MCP_PROVIDER_OPTIONS.map((option) => option.id),
  };
}

function mcpServerToForm(server: McpServerConfig): McpFormState {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    argsText: (server.args ?? []).join("\n"),
    url: server.url ?? "",
    envText: mapToJSONString(server.env),
    headersText: mapToJSONString(server.headers),
    providers:
      server.providers.length > 0
        ? server.providers
        : MCP_PROVIDER_OPTIONS.map((option) => option.id),
  };
}

function mapToJSONString(value: Record<string, string> | undefined) {
  return value && Object.keys(value).length > 0
    ? JSON.stringify(value, null, 2)
    : "";
}

function parseStringMapText(
  value: string,
  fieldName: string,
): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== "string") {
      throw new Error(`${fieldName} values must be strings.`);
    }
    if (key.trim() && rawValue.trim()) {
      out[key.trim()] = rawValue.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mcpFormToServer(
  form: McpFormState,
  dictionary: ReturnType<typeof getDictionary>,
): McpServerConfig {
  const providers = form.providers.filter((provider) =>
    MCP_PROVIDER_OPTIONS.some((option) => option.id === provider),
  );
  return {
    name: form.name.trim(),
    transport: form.transport,
    providers,
    command: form.transport === "stdio" ? form.command.trim() : undefined,
    args:
      form.transport === "stdio"
        ? form.argsText
            .split(/\r?\n/)
            .map((arg) => arg.trim())
            .filter(Boolean)
        : undefined,
    url: form.transport === "http" ? form.url.trim() : undefined,
    env:
      form.transport === "stdio"
        ? parseStringMapText(form.envText, dictionary.settings.environment)
        : undefined,
    headers:
      form.transport === "http"
        ? parseStringMapText(form.headersText, dictionary.settings.headers)
        : undefined,
  };
}

function maskMcpDisplayValue(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes("key") ||
        normalizedKey.includes("token") ||
        normalizedKey.includes("secret")
      ) {
        url.searchParams.set(key, "****");
      }
    }
    return url.toString();
  } catch {
    return value.replace(/((?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1****");
  }
}

function mcpServerDisplayCommand(server: McpServerConfig) {
  if (server.transport === "http") {
    return maskMcpDisplayValue(server.url);
  }
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
}

function mcpRegistryDisplayCommand(result: McpRegistrySearchResult) {
  if (result.transport === "http") {
    return maskMcpDisplayValue(result.url);
  }
  return [result.command, ...(result.args ?? [])].filter(Boolean).join(" ");
}

function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
      view: window,
    }),
  );
}

function McpServerActionsMenu({
  server,
  direction,
  removing,
  onEdit,
  onRemove,
}: {
  server: McpServerConfig;
  direction: "ltr" | "rtl";
  removing: boolean;
  onEdit: (server: McpServerConfig) => void;
  onRemove: (name: string) => void;
}) {
  const { t } = useI18n();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          aria-label={t.settings.mcpServerActions(server.name)}
          onClick={openContextMenuFromButton}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {removing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent dir={direction}>
        <ContextMenuItem onSelect={() => onEdit(server)}>
          <SquarePen className="h-3.5 w-3.5" />
          <span>{t.settings.edit}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onRemove(server.name)}
          className="text-destructive hover:bg-destructive/10 focus:bg-destructive/10 dark:text-red-400 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>{t.settings.removeMcpServer}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function McpProviderToggle({
  provider,
  checked,
  disabled,
  busy,
  onToggle,
}: {
  provider: { id: McpProviderId; label: string };
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || busy}
      onClick={onToggle}
      className={cn(
        "inline-flex h-8 min-w-[118px] items-center justify-between gap-3 rounded-full border px-2.5 text-xs transition-colors",
        checked
          ? "border-primary/30 bg-primary/10 text-foreground"
          : "border-border/70 bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        disabled || busy ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
      dir="ltr"
    >
      <span className="truncate">{provider.label}</span>
      <span
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
          checked ? "bg-primary/80" : "bg-muted-foreground/25",
        )}
      >
        <span
          className={cn(
            "absolute h-3 w-3 rounded-full bg-background shadow-sm transition-transform",
            checked ? "translate-x-3.5" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

function McpRegistryResultRow({
  result,
  installed,
  installing,
  message,
  onInstall,
}: {
  result: McpRegistrySearchResult;
  installed: boolean;
  installing: boolean;
  message?: string;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const statusMessage = installed
    ? t.settings.installedInConfigs
    : message
      ? message
      : result.installable
        ? result.requiresConfiguration
          ? t.settings.requiresConfiguration
          : null
        : result.installReason || t.settings.notInstallable;
  const statusTone = installed
    ? "text-emerald-500"
    : !result.installable
      ? "text-destructive"
      : "text-muted-foreground";
  const command = mcpRegistryDisplayCommand(result);
  const sourceURL =
    result.sourceUrl || result.repositoryUrl || result.websiteUrl;

  return (
    <div
      className="grid gap-3 py-4 text-left md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4"
      dir="ltr"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold text-foreground">
            {result.name}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {result.registryName}
          </span>
          {result.version ? (
            <span className="text-xs text-muted-foreground">
              v{result.version}
            </span>
          ) : null}
          {result.status && result.status !== "active" ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {result.status}
            </span>
          ) : null}
        </div>
        {result.description ? (
          <div className="mt-1 line-clamp-2 max-w-3xl text-xs text-muted-foreground">
            {result.description}
          </div>
        ) : null}
        {command ? (
          <div className="mt-1 max-w-3xl truncate font-mono text-xs text-muted-foreground">
            {command}
          </div>
        ) : null}
        {statusMessage ? (
          <div className={cn("mt-1 truncate text-xs", statusTone)}>
            {statusMessage}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {sourceURL ? (
          <a
            href={sourceURL}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${result.name} source`}
            className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={installed ? "secondary" : "default"}
          disabled={
            installing || installed || !result.installable || !result.config
          }
          onClick={onInstall}
          className="h-7 rounded-full px-2.5 text-xs"
        >
          {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {installed
            ? t.settings.installed
            : installing
              ? t.settings.installing
              : t.settings.get}
        </Button>
      </div>
    </div>
  );
}

function McpRegistrySkeletonList() {
  const rows = [
    ["w-40", "w-64", "w-28"],
    ["w-56", "w-80", "w-32"],
    ["w-44", "w-72", "w-24"],
    ["w-52", "w-60", "w-36"],
  ];
  return (
    <div className="border-t border-border" aria-hidden="true">
      {rows.map((row, index) => (
        <div
          key={index}
          className={cn(
            "grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4",
            index > 0 ? "border-t border-border" : undefined,
          )}
        >
          <div className="min-w-0 animate-pulse space-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className={cn("h-4 rounded bg-muted", row[0])} />
              <div className="h-3 w-32 rounded bg-muted/70" />
              <div className="h-3 w-12 rounded bg-muted/70" />
            </div>
            <div className={cn("h-3 max-w-full rounded bg-muted/70", row[1])} />
            <div className={cn("h-3 rounded bg-muted/60", row[2])} />
          </div>
          <div className="flex shrink-0 animate-pulse items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-muted/70" />
            <div className="h-7 w-16 rounded-full bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function McpSection({
  state,
}: {
  state: Pick<AbolqasemState, "connectionStatus" | "socket">;
}) {
  const { t, direction } = useI18n();
  const socket = state.socket;
  const connectionStatus = state.connectionStatus;
  const registrySectionRef = useRef<HTMLElement | null>(null);
  const registrySearchInputRef = useRef<HTMLInputElement | null>(null);
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [confirmRemoveName, setConfirmRemoveName] = useState<string | null>(
    null,
  );
  const [editingName, setEditingName] = useState<string | null>(null);
  const [updatingProviderKey, setUpdatingProviderKey] = useState<string | null>(
    null,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<McpFormState>(() => emptyMcpForm());
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryResults, setRegistryResults] = useState<
    McpRegistrySearchResult[]
  >([]);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [installingRegistryId, setInstallingRegistryId] = useState<
    string | null
  >(null);
  const [registryMessages, setRegistryMessages] = useState<
    Record<string, string>
  >({});

  async function loadMcpServers() {
    if (connectionStatus !== "connected") {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      setSnapshot(
        await socket.command<McpSettingsSnapshot>({ type: "mcp.list" }),
      );
    } catch (loadError) {
      setSnapshot(null);
      setError(
        loadError instanceof Error
          ? loadError.message
          : t.settings.unableReadMcpServers,
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMcpServers();
  }, [connectionStatus, socket]);

  useEffect(() => {
    const normalizedQuery = registryQuery.trim();
    if (normalizedQuery.length < 2) {
      setRegistryResults([]);
      setRegistryError(null);
      setRegistryLoading(false);
      return;
    }

    if (connectionStatus !== "connected") {
      setRegistryResults([]);
      setRegistryLoading(false);
      setRegistryError(t.settings.backendConnectionRequired);
      return;
    }

    let cancelled = false;
    setRegistryLoading(true);
    setRegistryError(null);

    const timeout = window.setTimeout(() => {
      void socket
        .command<McpRegistrySearchSnapshot>({
          type: "mcp.registrySearch",
          query: normalizedQuery,
          limit: 50,
        })
        .then((searchSnapshot) => {
          if (cancelled) return;
          setRegistryResults(searchSnapshot.servers);
        })
        .catch((searchError) => {
          if (cancelled) return;
          setRegistryResults([]);
          setRegistryError(
            searchError instanceof Error
              ? searchError.message
              : t.settings.unableSearchMcpRegistry,
          );
        })
        .finally(() => {
          if (cancelled) return;
          setRegistryLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [connectionStatus, registryQuery, socket]);

  async function saveServer() {
    if (connectionStatus !== "connected") {
      setError(t.settings.backendConnectionRequired);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const result = await socket.command<McpSaveResult>({
        type: "mcp.save",
        server: mcpFormToServer(form, t),
      });
      setSnapshot({ configPaths: result.configPaths, servers: result.servers });
      closeMcpDialog();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t.settings.unableSaveMcpServer,
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeServer(name: string) {
    if (connectionStatus !== "connected") {
      setError(t.settings.backendConnectionRequired);
      return;
    }
    try {
      setRemovingName(name);
      setError(null);
      setSnapshot(
        await socket.command<McpSettingsSnapshot>({ type: "mcp.remove", name }),
      );
      setConfirmRemoveName(null);
      if (editingName === name) {
        setEditingName(null);
        setForm(emptyMcpForm());
      }
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : t.settings.unableRemoveMcpServer,
      );
    } finally {
      setRemovingName(null);
    }
  }

  async function updateServerProviders(
    server: McpServerConfig,
    providers: McpProviderId[],
  ) {
    if (connectionStatus !== "connected") {
      setError(t.settings.backendConnectionRequired);
      return;
    }
    if (providers.length === 0) return;
    try {
      setUpdatingProviderKey(server.name);
      setError(null);
      const result = await socket.command<McpSaveResult>({
        type: "mcp.save",
        server: { ...server, providers },
      });
      setSnapshot({ configPaths: result.configPaths, servers: result.servers });
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t.settings.unableSaveMcpServer,
      );
    } finally {
      setUpdatingProviderKey(null);
    }
  }

  async function installRegistryServer(result: McpRegistrySearchResult) {
    if (connectionStatus !== "connected") {
      setRegistryError(t.settings.backendConnectionRequired);
      return;
    }
    if (!result.config) {
      setRegistryError(result.installReason || t.settings.notInstallable);
      return;
    }
    try {
      setInstallingRegistryId(result.id);
      setRegistryError(null);
      setRegistryMessages((current) => {
        const next = { ...current };
        delete next[result.id];
        return next;
      });
      const saveResult = await socket.command<McpRegistryInstallResult>({
        type: "mcp.registryInstall",
        config: result.config,
        installCommand: result.installCommand,
      });
      setSnapshot({
        configPaths: saveResult.configPaths,
        servers: saveResult.servers,
      });
      setRegistryMessages((current) => ({
        ...current,
        [result.id]: t.settings.installedInConfigs,
      }));
    } catch (installError) {
      setRegistryError(
        installError instanceof Error
          ? installError.message
          : t.settings.unableSaveMcpServer,
      );
    } finally {
      setInstallingRegistryId(null);
    }
  }

  function toggleServerProvider(
    server: McpServerConfig,
    provider: McpProviderId,
  ) {
    const hasProvider = server.providers.includes(provider);
    const nextProviders = hasProvider
      ? server.providers.filter((candidate) => candidate !== provider)
      : [...server.providers, provider];
    void updateServerProviders(server, nextProviders);
  }

  function openAddDialog() {
    setError(null);
    setEditingName(null);
    setForm(emptyMcpForm());
    setDialogOpen(true);
  }

  function scrollToRegistrySearch() {
    registrySectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    window.setTimeout(() => registrySearchInputRef.current?.focus(), 250);
  }

  function openEditDialog(server: McpServerConfig) {
    setError(null);
    setEditingName(server.name);
    setForm(mcpServerToForm(server));
    setDialogOpen(true);
  }

  function closeMcpDialog() {
    setDialogOpen(false);
    setEditingName(null);
    setForm(emptyMcpForm());
  }

  function toggleProvider(provider: McpProviderId) {
    setForm((current) => {
      const hasProvider = current.providers.includes(provider);
      return {
        ...current,
        providers: hasProvider
          ? current.providers.filter((candidate) => candidate !== provider)
          : [...current.providers, provider],
      };
    });
  }

  const servers = snapshot?.servers ?? [];
  const configPaths = snapshot?.configPaths;
  const configuredServerNames = useMemo(
    () => new Set(servers.map((server) => server.name)),
    [servers],
  );

  return (
    <div className="flex flex-col">
      {error ? <SkillErrorBlock message={error} /> : null}

      <section className="border-b border-border">
        <SettingsRow
          title={t.settings.configuredMcpServers}
          description={t.settings.mcpServersDescription}
          bordered={false}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={scrollToRegistrySearch}
            >
              <Search className="h-4 w-4" />
              {t.settings.searchMcpRegistryAction}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openAddDialog}
            >
              <Plus className="h-4 w-4" />
              {t.settings.addMcpServer}
            </Button>
          </div>
        </SettingsRow>

        {servers.length > 0 ? (
          <div className="border-t border-border">
            {servers.map((server, index) => (
              <div
                key={server.name}
                className={cn(
                  "grid gap-3 py-4 text-left md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-4",
                  index > 0 ? "border-t border-border" : undefined,
                )}
                dir="ltr"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className="truncate font-mono text-sm font-semibold text-foreground"
                      dir="ltr"
                    >
                      {server.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {server.transport === "http"
                        ? t.settings.http
                        : t.settings.stdio}
                    </span>
                  </div>
                  <div
                    className="mt-1 max-w-3xl truncate font-mono text-xs text-muted-foreground"
                    dir="ltr"
                  >
                    {mcpServerDisplayCommand(server)}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
                  {MCP_PROVIDER_OPTIONS.map((provider) => {
                    const checked = server.providers.includes(provider.id);
                    const lastCheckedProvider =
                      checked && server.providers.length === 1;
                    return (
                      <McpProviderToggle
                        key={provider.id}
                        provider={provider}
                        checked={checked}
                        disabled={
                          lastCheckedProvider || Boolean(updatingProviderKey)
                        }
                        busy={updatingProviderKey === server.name}
                        onToggle={() =>
                          toggleServerProvider(server, provider.id)
                        }
                      />
                    );
                  })}
                </div>
                <McpServerActionsMenu
                  server={server}
                  direction={direction}
                  removing={removingName === server.name}
                  onEdit={openEditDialog}
                  onRemove={setConfirmRemoveName}
                />
              </div>
            ))}
          </div>
        ) : !loading ? (
          <div className="border-t border-border py-4 text-sm text-muted-foreground">
            {t.settings.noMcpServersConfigured}
          </div>
        ) : null}
      </section>

      <section
        ref={registrySectionRef}
        className="mt-7 scroll-mt-4 border-y border-border"
      >
        <SettingsRow
          title={t.settings.registryMcpServers}
          description={t.settings.registryMcpServersDescription}
          bordered={false}
          alignStart
        >
          <div className="w-full min-w-0 md:w-[560px]">
            <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card/30 px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={registrySearchInputRef}
                type="text"
                role="searchbox"
                value={registryQuery}
                onChange={(event) => setRegistryQuery(event.target.value)}
                placeholder={t.settings.searchMcpRegistry}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                dir="ltr"
              />
              {registryQuery ? (
                <button
                  type="button"
                  aria-label={t.settings.clearMcpRegistrySearch}
                  onClick={() => setRegistryQuery("")}
                  className="touch-manipulation inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {registryLoading ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
            </div>
            {registryError ? (
              <div className="mt-2 text-xs text-destructive">
                {registryError}
              </div>
            ) : null}
          </div>
        </SettingsRow>

        {registryLoading ? (
          <McpRegistrySkeletonList />
        ) : registryResults.length > 0 ? (
          <div className="border-t border-border">
            {registryResults.map((result, index) => (
              <div
                key={result.id}
                className={index > 0 ? "border-t border-border" : undefined}
              >
                <McpRegistryResultRow
                  result={result}
                  installed={Boolean(
                    result.configName &&
                    configuredServerNames.has(result.configName),
                  )}
                  installing={installingRegistryId === result.id}
                  message={registryMessages[result.id]}
                  onInstall={() => {
                    void installRegistryServer(result);
                  }}
                />
              </div>
            ))}
          </div>
        ) : !registryLoading &&
          !registryError &&
          registryQuery.trim().length >= 2 ? (
          <div className="border-t border-border py-4 text-sm text-muted-foreground">
            {t.settings.noMcpRegistryServersFound}
          </div>
        ) : null}
      </section>

      {configPaths ? (
        <section className="mt-7 border-y border-border">
          <SettingsRow
            title={t.settings.mcpConfigFiles}
            description={t.settings.mcpConfigFilesDescription}
            bordered={false}
            alignStart
          >
            <div
              className="grid w-full min-w-0 overflow-hidden rounded-lg border border-border/60 text-left text-xs md:w-[560px]"
              dir="ltr"
            >
              {MCP_PROVIDER_OPTIONS.map((provider) => (
                <div
                  key={provider.id}
                  className="grid min-w-0 grid-cols-[112px_minmax(0,1fr)] items-center border-t border-border/60 first:border-t-0"
                >
                  <span className="border-r border-border/60 px-3 py-2 font-medium text-muted-foreground">
                    {provider.label}
                  </span>
                  <span
                    className="truncate px-3 py-2 font-mono text-foreground/80"
                    dir="ltr"
                  >
                    {configPaths[provider.id]}
                  </span>
                </div>
              ))}
            </div>
          </SettingsRow>
        </section>
      ) : null}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setDialogOpen(true);
          } else {
            closeMcpDialog();
          }
        }}
      >
        <DialogContent size="lg" className="max-w-[640px]" dir={direction}>
          <DialogHeader>
            <DialogTitle>
              {editingName
                ? t.settings.editMcpServer(editingName)
                : t.settings.addMcpServer}
            </DialogTitle>
            <DialogDescription>
              {t.settings.mcpServersDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  {t.settings.serverName}
                </span>
                <Input
                  value={form.name}
                  disabled={Boolean(editingName)}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="browsermcp"
                  dir="ltr"
                  className="font-mono"
                />
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  {t.settings.transport}
                </span>
                <Select
                  value={form.transport}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      transport: value as McpTransport,
                    }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="stdio">{t.settings.stdio}</SelectItem>
                      <SelectItem value="http">{t.settings.http}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
            </div>

            {form.transport === "stdio" ? (
              <>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t.settings.command}
                  </span>
                  <Input
                    value={form.command}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        command: event.target.value,
                      }))
                    }
                    placeholder="npx"
                    dir="ltr"
                    className="font-mono"
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t.settings.arguments}
                  </span>
                  <textarea
                    value={form.argsText}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        argsText: event.target.value,
                      }))
                    }
                    placeholder="browsermcp"
                    className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    dir="ltr"
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t.settings.environment}
                  </span>
                  <textarea
                    value={form.envText}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        envText: event.target.value,
                      }))
                    }
                    placeholder={t.settings.environmentPlaceholder}
                    className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    dir="ltr"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t.settings.url}
                  </span>
                  <Input
                    value={form.url}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        url: event.target.value,
                      }))
                    }
                    placeholder="https://example.com/mcp"
                    dir="ltr"
                    className="font-mono"
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t.settings.headers}
                  </span>
                  <textarea
                    value={form.headersText}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        headersText: event.target.value,
                      }))
                    }
                    placeholder={t.settings.headersPlaceholder}
                    className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    dir="ltr"
                  />
                </label>
              </>
            )}

            <div className="grid gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t.settings.providers}
              </div>
              <div className="flex flex-wrap gap-2" dir="ltr">
                {MCP_PROVIDER_OPTIONS.map((provider) => {
                  const selected = form.providers.includes(provider.id);
                  const lastSelectedProvider =
                    selected && form.providers.length === 1;
                  return (
                    <McpProviderToggle
                      key={provider.id}
                      provider={provider}
                      checked={selected}
                      disabled={lastSelectedProvider}
                      onToggle={() => toggleProvider(provider.id)}
                    />
                  );
                })}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={closeMcpDialog}
            >
              {t.settings.cancel}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void saveServer()}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editingName ? t.settings.saveMcpServer : t.settings.addMcpServer}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(confirmRemoveName)}
        onOpenChange={(open) => !open && setConfirmRemoveName(null)}
      >
        <DialogContent size="sm" dir={direction}>
          <DialogBody className="space-y-2">
            <DialogTitle>
              {t.settings.confirmRemoveMcpServer(confirmRemoveName ?? "")}
            </DialogTitle>
            <DialogDescription>
              {t.settings.confirmRemoveMcpServerDescription}
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemoveName(null)}
            >
              {t.settings.cancel}
            </Button>
            <Button
              type="button"
              variant="none"
              size="sm"
              className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:text-white dark:hover:bg-red-600"
              disabled={
                !confirmRemoveName || removingName === confirmRemoveName
              }
              onClick={() => {
                if (!confirmRemoveName) return;
                void removeServer(confirmRemoveName);
              }}
            >
              {removingName === confirmRemoveName ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {t.settings.removeMcpServer}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function shouldShowSettingsContentLoading(
  hasSettings: boolean,
  connectionStatus: "connecting" | "connected" | "disconnected",
  localProjectsReady: boolean,
  hydrationStatus: "idle" | "loading" | "ready" | "error",
) {
  if (hasSettings) return false;
  if (hydrationStatus === "error") return false;
  return (
    connectionStatus !== "connected" ||
    !localProjectsReady ||
    hydrationStatus === "idle" ||
    hydrationStatus === "loading"
  );
}

function SettingsContentPlaceholder({
  locale,
  error,
  onRetry,
}: {
  locale: AppLocale;
  error: string | null;
  onRetry: () => void;
}) {
  const fa = locale === "fa";
  if (error) {
    return (
      <div
        className="mx-auto flex min-h-[240px] max-w-4xl items-center justify-center rounded-2xl border border-destructive/25 bg-card/40 px-5 py-8 text-center"
        role="alert"
      >
        <div className="max-w-md space-y-3">
          <div className="text-sm font-medium text-foreground">
            {fa
              ? "تنظیمات هنوز در دسترس نیست"
              : "Settings are not available yet"}
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            {fa
              ? "ارتباط با سرویس محلی کامل نشد. تنظیمات ذخیره‌شده تغییری نکرده‌اند."
              : "The local service did not return settings. Your saved settings have not changed."}
          </p>
          <p className="text-xs text-destructive/90">{error}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="size-4" />
            {fa ? "تلاش دوباره" : "Try again"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-4xl space-y-5"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="space-y-2">
        <div className="h-6 w-32 animate-pulse rounded-md bg-muted/60" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded-md bg-muted/35" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card/30">
        {["one", "two", "three"].map((key) => (
          <div
            key={key}
            className="flex min-h-24 items-center justify-between gap-6 border-b border-border px-5 py-5 last:border-b-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-40 animate-pulse rounded bg-muted/55" />
              <div className="h-3 w-72 max-w-full animate-pulse rounded bg-muted/30" />
            </div>
            <div className="h-9 w-28 shrink-0 animate-pulse rounded-lg bg-muted/45" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>{fa ? "در حال بازیابی تنظیمات…" : "Restoring settings…"}</span>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { sectionId } = useParams<{ sectionId: string }>();
  const state = useOutletContext<AbolqasemState>();
  const [changelogStatus, setChangelogStatus] =
    useState<ChangelogStatus>("idle");
  const [signingOut, setSigningOut] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [releases, setReleases] = useState<GithubRelease[]>([]);
  const [changelogError, setChangelogError] = useState<string | null>(null);
  const selectedPage = resolveSettingsSectionId(sectionId) ?? "general";
  useEffect(() => {
    if (selectedPage !== "general") return;
    const targetId = location.hash.replace(/^#/, "");
    if (!targetId) return;
    const rafId = window.requestAnimationFrame(() => {
      document
        .getElementById(targetId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [location.hash, selectedPage]);
  const isConnecting =
    state.connectionStatus === "connecting" || !state.localProjectsReady;
  const appSettings = state.appSettings;
  const appSettingsHydrationStatus = useAppSettingsStore(
    (store) => store.hydrationStatus,
  );
  const showSettingsContentLoading = shouldShowSettingsContentLoading(
    Boolean(appSettings),
    state.connectionStatus,
    state.localProjectsReady,
    appSettingsHydrationStatus,
  );
  const settingsAvailableProviders = appSettings?.availableProviders?.length
    ? appSettings.availableProviders
    : PROVIDERS;
  const providerModelCatalog = appSettings?.providerModelCatalog;
  const locale = normalizeLocale(appSettings?.locale);
  const dictionary = getDictionary(locale);
  const direction = getLocaleDirection(locale);
  const machineName =
    state.localProjects?.machine.displayName ?? dictionary.settings.unavailable;
  const projectCount = state.localProjects?.projects.length ?? 0;
  const appVersion = resolveSettingsAppVersion(
    state.updateSnapshot,
    appSettings,
  );
  const scrollbackLines = useTerminalPreferencesStore(
    (store) => store.scrollbackLines,
  );
  const minColumnWidth = useTerminalPreferencesStore(
    (store) => store.minColumnWidth,
  );
  const editorPreset = useTerminalPreferencesStore(
    (store) => store.editorPreset,
  );
  const editorCommandTemplate = useTerminalPreferencesStore(
    (store) => store.editorCommandTemplate,
  );
  const setScrollbackLines = useTerminalPreferencesStore(
    (store) => store.setScrollbackLines,
  );
  const setMinColumnWidth = useTerminalPreferencesStore(
    (store) => store.setMinColumnWidth,
  );
  const setEditorPreset = useTerminalPreferencesStore(
    (store) => store.setEditorPreset,
  );
  const setEditorCommandTemplate = useTerminalPreferencesStore(
    (store) => store.setEditorCommandTemplate,
  );
  const chatSoundPreference = useChatSoundPreferencesStore(
    (store) => store.chatSoundPreference,
  );
  const chatSoundId = useChatSoundPreferencesStore(
    (store) => store.chatSoundId,
  );
  const setChatSoundPreference = useChatSoundPreferencesStore(
    (store) => store.setChatSoundPreference,
  );
  const setChatSoundId = useChatSoundPreferencesStore(
    (store) => store.setChatSoundId,
  );
  const keybindings = state.keybindings;
  const llmProvider = state.llmProvider;
  const defaultProvider = useChatPreferencesStore(
    (store) => store.defaultProvider,
  );
  const providerDefaults = useChatPreferencesStore(
    (store) => store.providerDefaults,
  );
  const setDefaultProvider = useChatPreferencesStore(
    (store) => store.setDefaultProvider,
  );
  const setProviderDefaultModel = useChatPreferencesStore(
    (store) => store.setProviderDefaultModel,
  );
  const setProviderDefaultModelOptions = useChatPreferencesStore(
    (store) => store.setProviderDefaultModelOptions,
  );
  const setProviderDefaultPlanMode = useChatPreferencesStore(
    (store) => store.setProviderDefaultPlanMode,
  );
  const resolvedKeybindings = useMemo(
    () => getResolvedKeybindings(keybindings),
    [keybindings],
  );
  const keybindingsFilePathDisplay =
    resolvedKeybindings.filePathDisplay || getKeybindingsFilePathDisplay();
  const localizedSidebarItems = useMemo(
    () =>
      sidebarItems.map((item) => {
        const sections = {
          general: {
            label: dictionary.settings.general,
            subtitle: dictionary.settings.generalSubtitle,
          },
          "codex-manager": {
            label: locale === "fa" ? "اکانت‌های کدکس" : "Codex Accounts",
            subtitle:
              locale === "fa"
                ? "افزودن حساب، بررسی سهمیه و تعویض خودکار حساب‌ها."
                : "Add accounts, review limits, and manage automatic switching.",
          },
          skills: {
            label: dictionary.settings.skills,
            subtitle: dictionary.settings.skillsSubtitle,
          },
          mcp: {
            label: dictionary.settings.mcpServers,
            subtitle: dictionary.settings.mcpServersSubtitle,
          },
          providers: {
            label: dictionary.settings.providers,
            subtitle: dictionary.settings.providersSubtitle,
          },
          proxy: {
            label: dictionary.settings.proxy,
            subtitle: dictionary.settings.proxySubtitle,
          },
          telegram: {
            label: locale === "fa" ? "تلگرام" : "Telegram",
            subtitle:
              locale === "fa"
                ? "اتصال امن ربات تلگرام به چت‌های Codex."
                : "Connect an allowlisted Telegram bot to existing Codex chats.",
          },
          usage: {
            label: locale === "fa" ? "مصرف" : "Usage",
            subtitle:
              locale === "fa"
                ? "محدودیت‌های Codex و فضای کش محلی."
                : "Review Codex limits and local cache usage.",
          },
          keybindings: {
            label: dictionary.settings.keybindings,
            subtitle: dictionary.settings.keybindingsSubtitle,
          },
          changelog: {
            label: dictionary.settings.changelog,
            subtitle: dictionary.settings.changelogSubtitle,
          },
        } satisfies Record<SidebarPageId, { label: string; subtitle: string }>;
        return { ...item, ...sections[item.id] };
      }),
    [dictionary, locale],
  );
  const localizedChatSoundPreferenceOptions = useMemo(
    () => [
      {
        value: "never" as ChatSoundPreference,
        label: dictionary.settings.options.never,
      },
      {
        value: "unfocused" as ChatSoundPreference,
        label: dictionary.settings.options.unfocused,
      },
      {
        value: "always" as ChatSoundPreference,
        label: dictionary.settings.options.always,
      },
    ],
    [dictionary],
  );
  const localizedChatSoundOptions = useMemo(
    () =>
      CHAT_SOUND_OPTIONS.map((option) => ({
        ...option,
        label: dictionary.settings.chatSoundLabels[option.value],
      })),
    [dictionary],
  );
  const localizedProviderProxyOptions = useMemo(
    () => [
      {
        value: "none" as ProviderProxyMode,
        label: dictionary.settings.providerProxyNone,
      },
      {
        value: "custom" as ProviderProxyMode,
        label: dictionary.settings.providerProxyCustom,
      },
    ],
    [dictionary],
  );
  const localizedHookEnabledOptions = useMemo(
    () => [
      { value: "disabled" as const, label: dictionary.settings.options.off },
      { value: "enabled" as const, label: dictionary.settings.options.on },
    ],
    [dictionary],
  );
  const localizedHookFollowOptions = useMemo(
    () => [
      { value: "auto" as const, label: dictionary.settings.options.auto },
      { value: "notice" as const, label: dictionary.settings.options.notice },
      { value: "off" as const, label: dictionary.settings.options.off },
    ],
    [dictionary],
  );
  const modelCatalogLastRefresh = useMemo(() => {
    const timestamps = Object.values(providerModelCatalog ?? {})
      .map((inventory) => Date.parse(inventory.lastRefreshAt ?? ""))
      .filter((value) => Number.isFinite(value));
    if (timestamps.length === 0) return dictionary.settings.options.never;
    return dictionary.settings.lastCheckedAt(
      new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(Math.max(...timestamps)),
    );
  }, [dictionary, locale, providerModelCatalog]);
  const modelCatalogErrorCount = useMemo(
    () =>
      Object.values(providerModelCatalog ?? {}).filter((inventory) =>
        Boolean(inventory.lastError),
      ).length,
    [providerModelCatalog],
  );
  const commitMessageGenerator = appSettings?.commitMessageGenerator ?? {
    provider: "codex" as AgentProvider,
    model: providerDefaults.codex.model,
  };
  const commitMessageProviderConfig = providerCatalogEntry(
    commitMessageGenerator.provider,
  );
  const commitMessageModelOptions = useMemo(() => {
    if (
      !commitMessageGenerator.model ||
      commitMessageProviderConfig.models.some(
        (model) => model.id === commitMessageGenerator.model,
      )
    ) {
      return commitMessageProviderConfig.models;
    }
    return [
      {
        id: commitMessageGenerator.model,
        label: commitMessageGenerator.model,
        supportsEffort: false,
      },
      ...commitMessageProviderConfig.models,
    ];
  }, [commitMessageGenerator.model, commitMessageProviderConfig.models]);
  const [scrollbackDraft, setScrollbackDraft] = useState(
    String(scrollbackLines),
  );
  const [minColumnWidthDraft, setMinColumnWidthDraft] = useState(
    String(minColumnWidth),
  );
  const [editorCommandDraft, setEditorCommandDraft] = useState(
    editorCommandTemplate,
  );
  const [providerProxyHttpDraft, setProviderProxyHttpDraft] = useState("");
  const [providerProxyNoProxyDraft, setProviderProxyNoProxyDraft] =
    useState("");
  const [providerExecutableDrafts, setProviderExecutableDrafts] = useState<
    Partial<Record<AgentProvider, string>>
  >({});
  const [keybindingDrafts, setKeybindingDrafts] = useState<
    Record<string, string>
  >({});
  const [keybindingsError, setKeybindingsError] = useState<string | null>(null);
  const [appSettingsError, setAppSettingsError] = useState<string | null>(null);
  const [modelRefreshStatus, setModelRefreshStatus] = useState<
    "idle" | "loading" | "success"
  >("idle");
  const [modelCatalogDrafts, setModelCatalogDrafts] =
    useState<ModelCatalogDrafts>(() => emptyModelCatalogDrafts());
  const [newModelCatalogDrafts, setNewModelCatalogDrafts] =
    useState<NewModelCatalogDrafts>(() => emptyNewModelCatalogDrafts());
  const [llmProviderDraft, setLlmProviderDraft] = useState({
    provider: "openai" as LlmProviderKind,
    apiKey: "",
    model: "",
    baseUrl: "",
  });
  const [llmProviderError, setLlmProviderError] = useState<string | null>(null);
  const [llmValidationStatus, setLlmValidationStatus] = useState<
    "idle" | "valid" | "invalid"
  >("idle");
  const [llmValidationError, setLlmValidationError] = useState<unknown | null>(
    null,
  );
  const [llmValidationDialogOpen, setLlmValidationDialogOpen] = useState(false);
  const [telegramDraft, setTelegramDraft] = useState<{
    botToken: string;
    proxyUrl: string;
    allowedUserIds: string;
    customCommands: TelegramCustomCommandDraft[];
  }>({ botToken: "", proxyUrl: "", allowedUserIds: "", customCommands: [] });
  const [telegramStatus, setTelegramStatus] = useState<{
    configured: boolean;
    active: boolean;
    proxyConfigured: boolean;
    mappedChats: number;
    knownChats: number;
    lastError: string;
  } | null>(null);
  const [telegramLoaded, setTelegramLoaded] = useState(false);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramNotice, setTelegramNotice] = useState<string | null>(null);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [codexManagerGateway, setCodexManagerGateway] =
    useState<CodexManagerGatewaySnapshot | null>(null);
  const [codexManagerPending, setCodexManagerPending] = useState(false);
  const [codexManagerError, setCodexManagerError] = useState<string | null>(
    null,
  );
  const [customProviderEditorOpen, setCustomProviderEditorOpen] =
    useState(false);
  const [deviceLoginOpen, setDeviceLoginOpen] = useState(false);
  const [deviceLoginAccountName, setDeviceLoginAccountName] = useState("");
  const [codexManagerRefreshKey, setCodexManagerRefreshKey] = useState(0);
  const [codexManagerTab, setCodexManagerTab] =
    useState<CodexManagerTab>("accounts");
  const updateSnapshot = state.updateSnapshot;
  const handleWriteAppSettings = state.handleWriteAppSettings;
  const handleReadLlmProvider = state.handleReadLlmProvider;
  const handleWriteLlmProvider = state.handleWriteLlmProvider;
  const handleValidateLlmProvider = state.handleValidateLlmProvider;
  const updateStatusLabel =
    updateSnapshot?.status === "checking"
      ? dictionary.settings.updateChecking
      : updateSnapshot?.status === "updating"
        ? dictionary.settings.updateInstalling
        : updateSnapshot?.status === "restart_pending"
          ? dictionary.settings.updateRestarting
          : updateSnapshot?.status === "available"
            ? dictionary.settings.updateAvailable(
                updateSnapshot.latestVersion ?? undefined,
              )
            : updateSnapshot?.status === "up_to_date"
              ? dictionary.settings.updateUpToDate
              : updateSnapshot?.status === "error"
                ? dictionary.settings.updateCheckFailed
                : dictionary.settings.updateNotChecked;
  const localizedConnectionStatus =
    state.connectionStatus === "connected"
      ? dictionary.sidebar.connected
      : state.connectionStatus === "connecting"
        ? dictionary.sidebar.connecting
        : dictionary.sidebar.disconnected;
  const footerLabelClassName = cn(
    "mb-1 text-[11px] text-muted-foreground/80",
    direction === "rtl" ? "tracking-normal" : "uppercase tracking-wide",
  );

  useEffect(() => {
    setScrollbackDraft(String(scrollbackLines));
  }, [scrollbackLines]);

  useEffect(() => {
    setMinColumnWidthDraft(String(minColumnWidth));
  }, [minColumnWidth]);

  useEffect(() => {
    setEditorCommandDraft(editorCommandTemplate);
  }, [editorCommandTemplate]);

  useEffect(() => {
    setProviderProxyHttpDraft(appSettings?.providerProxy.httpProxy ?? "");
    setProviderProxyNoProxyDraft(appSettings?.providerProxy.noProxy ?? "");
  }, [
    appSettings?.providerProxy.httpProxy,
    appSettings?.providerProxy.noProxy,
  ]);

  useEffect(() => {
    setProviderExecutableDrafts({
      claude: appSettings?.providerExecutables?.claude ?? "",
      codex: appSettings?.providerExecutables?.codex ?? "",
      opencode: appSettings?.providerExecutables?.opencode ?? "",
    });
  }, [
    appSettings?.providerExecutables?.claude,
    appSettings?.providerExecutables?.codex,
    appSettings?.providerExecutables?.opencode,
  ]);

  useEffect(() => {
    setKeybindingDrafts(
      Object.fromEntries(
        KEYBINDING_ACTIONS.map((action) => [
          action,
          formatKeybindingInput(resolvedKeybindings.bindings[action]),
        ]),
      ),
    );
  }, [resolvedKeybindings]);

  useEffect(() => {
    setModelCatalogDrafts(
      Object.fromEntries(
        AGENT_PROVIDER_IDS.map((provider) => [
          provider,
          cloneProviderModelOptions(
            findProviderCatalogEntry(settingsAvailableProviders, provider)
              .models,
          ),
        ]),
      ) as ModelCatalogDrafts,
    );
  }, [settingsAvailableProviders]);

  useEffect(() => {
    if (!llmProvider) return;
    setLlmProviderDraft({
      provider: llmProvider.provider,
      apiKey: llmProvider.apiKey,
      model: llmProvider.model,
      baseUrl: llmProvider.baseUrl,
    });
  }, [llmProvider]);

  useEffect(() => {
    setLlmValidationStatus("idle");
    setLlmValidationError(null);
  }, [
    llmProviderDraft.provider,
    llmProviderDraft.apiKey,
    llmProviderDraft.model,
    llmProviderDraft.baseUrl,
  ]);

  useEffect(() => {
    if (!sectionId) return;
    if (resolveSettingsSectionId(sectionId)) return;
    navigate(settingsRoute("general"), { replace: true });
  }, [navigate, sectionId]);

  useEffect(() => {
    let cancelled = false;

    void fetch("/auth/status", {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) return { enabled: false };
        return (await response.json()) as { enabled?: boolean };
      })
      .then((payload) => {
        if (cancelled) return;
        setAuthEnabled(payload.enabled === true);
      })
      .catch(() => {
        if (cancelled) return;
        setAuthEnabled(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      (selectedPage !== "providers" && selectedPage !== "codex-manager") ||
      isConnecting
    )
      return;
    void handleReadLlmProvider();
  }, [handleReadLlmProvider, isConnecting, selectedPage]);

  useEffect(() => {
    if (
      (selectedPage !== "providers" && selectedPage !== "codex-manager") ||
      isConnecting
    )
      return;
    let cancelled = false;
    void fetch("/api/codex-manager", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as CodexManagerGatewaySnapshot;
      })
      .then((snapshot) => {
        if (!cancelled) setCodexManagerGateway(snapshot);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setCodexManagerError(
            error instanceof Error ? error.message : String(error),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [isConnecting, selectedPage]);

  useEffect(() => {
    if (selectedPage !== "changelog" || isConnecting) return;

    let cancelled = false;
    setChangelogStatus("loading");
    setChangelogError(null);

    void loadChangelog()
      .then((nextReleases) => {
        if (cancelled) return;
        setReleases(nextReleases);
        setChangelogStatus("success");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setChangelogError(
          error instanceof Error
            ? error.message
            : dictionary.settings.unableLoadChangelog,
        );
        setChangelogStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [isConnecting, selectedPage]);

  const refreshTelegram = useCallback(async () => {
    setTelegramLoading(true);
    try {
      const [configResponse, statusResponse] = await Promise.all([
        fetch("/api/telegram/config", { cache: "no-store" }),
        fetch("/api/telegram/status", { cache: "no-store" }),
      ]);
      if (!configResponse.ok || !statusResponse.ok)
        throw new Error(
          locale === "fa"
            ? "تنظیمات تلگرام بارگیری نشد."
            : "Telegram settings could not be loaded",
        );
      const config = (await configResponse.json()) as {
        botToken?: string;
        proxyUrl?: string;
        allowedUserIds?: string[];
        customCommands?: TelegramCustomCommandDraft[];
      };
      const status = (await statusResponse.json()) as {
        configured?: boolean;
        active?: boolean;
        proxyConfigured?: boolean;
        mappedChats?: number;
        knownChats?: number;
        lastError?: string;
      };
      setTelegramDraft({
        botToken: config.botToken ?? "",
        proxyUrl: config.proxyUrl ?? "",
        allowedUserIds: (config.allowedUserIds ?? []).join(", "),
        customCommands: (config.customCommands ?? []).map((command) => ({
          name: command.name ?? "",
          description: command.description ?? "",
          command: command.command ?? "",
          workingDirectory: command.workingDirectory ?? "",
          timeoutSeconds: command.timeoutSeconds ?? 30,
        })),
      });
      setTelegramStatus({
        configured: status.configured === true,
        active: status.active === true,
        proxyConfigured: status.proxyConfigured === true,
        mappedChats: status.mappedChats ?? 0,
        knownChats: status.knownChats ?? 0,
        lastError: status.lastError ?? "",
      });
      setTelegramLoaded(true);
    } finally {
      setTelegramLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    if (selectedPage !== "telegram" || isConnecting) return;
    setTelegramError(null);
    void refreshTelegram().catch((error: unknown) =>
      setTelegramError(error instanceof Error ? error.message : String(error)),
    );
  }, [isConnecting, refreshTelegram, selectedPage]);

  const saveTelegram = useCallback(async () => {
    const validationError = validateTelegramCustomCommandDrafts(
      telegramDraft.customCommands,
      locale,
    );
    if (validationError) {
      setTelegramError(validationError);
      return;
    }
    setTelegramSaving(true);
    setTelegramError(null);
    setTelegramNotice(null);
    try {
      const response = await fetch("/api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: telegramDraft.botToken,
          proxyUrl: telegramDraft.proxyUrl,
          allowedUserIds: telegramDraft.allowedUserIds
            .split(/[\s,]+/)
            .filter(Boolean),
          customCommands: telegramDraft.customCommands,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as {
        customCommands?: TelegramCustomCommandDraft[];
      };
      setTelegramDraft((current) => ({
        ...current,
        customCommands: (result.customCommands ?? current.customCommands).map(
          (command) => ({
            name: command.name ?? "",
            description: command.description ?? "",
            command: command.command ?? "",
            workingDirectory: command.workingDirectory ?? "",
            timeoutSeconds: command.timeoutSeconds ?? 30,
          }),
        ),
      }));
      await refreshTelegram();
    } catch (error) {
      setTelegramError(error instanceof Error ? error.message : String(error));
    } finally {
      setTelegramSaving(false);
    }
  }, [locale, refreshTelegram, telegramDraft]);

  const updateTelegramCustomCommand = useCallback(
    (index: number, patch: Partial<TelegramCustomCommandDraft>) => {
      setTelegramDraft((current) => ({
        ...current,
        customCommands: current.customCommands.map((command, commandIndex) =>
          commandIndex === index ? { ...command, ...patch } : command,
        ),
      }));
    },
    [],
  );

  const addTelegramCustomCommand = useCallback(() => {
    setTelegramDraft((current) => ({
      ...current,
      customCommands: [
        ...current.customCommands,
        {
          name: "",
          description: "",
          command: "",
          workingDirectory: "",
          timeoutSeconds: 30,
        },
      ],
    }));
  }, []);

  const removeTelegramCustomCommand = useCallback((index: number) => {
    setTelegramDraft((current) => ({
      ...current,
      customCommands: current.customCommands.filter(
        (_, commandIndex) => commandIndex !== index,
      ),
    }));
  }, []);

  const testTelegram = useCallback(async () => {
    setTelegramTesting(true);
    setTelegramError(null);
    setTelegramNotice(null);
    try {
      const response = await fetch("/api/telegram/test", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setTelegramNotice(
        locale === "fa"
          ? "پیام آزمایشی با Rich Markdown و RTL ارسال شد."
          : "Test message sent with Rich Markdown and RTL.",
      );
      await refreshTelegram();
    } catch (error) {
      setTelegramError(error instanceof Error ? error.message : String(error));
    } finally {
      setTelegramTesting(false);
    }
  }, [locale, refreshTelegram]);

  function commitScrollback() {
    const nextValue = Number(scrollbackDraft);
    if (!Number.isFinite(nextValue)) {
      setScrollbackDraft(String(scrollbackLines));
      return;
    }
    setScrollbackLines(nextValue);
    void handleWriteAppSettings({
      terminal: { scrollbackLines: nextValue },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save terminal settings.",
      );
    });
  }

  function commitMinColumnWidth() {
    const nextValue = Number(minColumnWidthDraft);
    if (!Number.isFinite(nextValue)) {
      setMinColumnWidthDraft(String(minColumnWidth));
      return;
    }
    setMinColumnWidth(nextValue);
    void handleWriteAppSettings({
      terminal: { minColumnWidth: nextValue },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save terminal settings.",
      );
    });
  }

  function handleNumberInputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    commit: () => void,
  ) {
    if (event.key !== "Enter") return;
    commit();
    event.currentTarget.blur();
  }

  function handleTextInputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    commit: () => void,
  ) {
    if (event.key !== "Enter") return;
    commit();
    event.currentTarget.blur();
  }

  function commitEditorCommand() {
    setEditorCommandTemplate(editorCommandDraft);
    void handleWriteAppSettings({
      editor: { commandTemplate: editorCommandDraft },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save editor settings.",
      );
    });
  }

  function handleLocaleChange(nextLocale: AppLocale) {
    void handleWriteAppSettings({ locale: nextLocale }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save language settings.",
      );
    });
  }

  function handleEditorPresetChange(nextPreset: EditorPreset) {
    setEditorPreset(nextPreset);
    const commandTemplate =
      nextPreset === "custom"
        ? editorCommandTemplate
        : getDefaultEditorCommandTemplate(nextPreset);
    void handleWriteAppSettings({
      editor: {
        preset: nextPreset,
        commandTemplate,
      },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save editor settings.",
      );
    });
  }

  function handleChatSoundPreferenceChange(nextValue: ChatSoundPreference) {
    if (!shouldPreviewChatSoundChange(chatSoundPreference, nextValue)) {
      return;
    }

    setChatSoundPreference(nextValue);
    void handleWriteAppSettings({ chatSoundPreference: nextValue }).catch(
      (error) => {
        setAppSettingsError(
          error instanceof Error
            ? error.message
            : "Unable to save chat sound settings.",
        );
      },
    );
    void playChatNotificationSound(chatSoundId, 1).catch(() => undefined);
  }

  function handleChatSoundIdChange(nextValue: ChatSoundId) {
    if (!shouldPreviewChatSoundChange(chatSoundId, nextValue)) {
      return;
    }

    setChatSoundId(nextValue);
    void handleWriteAppSettings({ chatSoundId: nextValue }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save chat sound settings.",
      );
    });
    void playChatNotificationSound(nextValue, 1).catch(() => undefined);
  }

  async function handleManagementPreferenceChange(patch: {
    hookUpdates?: boolean;
    hookFollowMode?: "auto" | "notice" | "off";
    filesystemDiscovery?: boolean;
  }) {
    try {
      setAppSettingsError(null);
      await state.socket.command({
        type: "app.writeManagementSettings",
        patch,
      });
      await state.handleReadAppSettings();
    } catch (error) {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save management settings.",
      );
    }
  }

  async function handleReloadSessions() {
    try {
      await state.socket.command({ type: "app.reloadSessions" });
    } catch (error) {
      setAppSettingsError(
        error instanceof Error ? error.message : "Unable to reload sessions.",
      );
    }
  }

  async function handleRestartServer() {
    try {
      await state.socket.command({ type: "app.restart" });
    } catch (error) {
      setAppSettingsError(
        error instanceof Error ? error.message : "Unable to restart server.",
      );
    }
  }

  function handleDefaultProviderChange(nextValue: "last_used" | AgentProvider) {
    setDefaultProvider(nextValue);
    void handleWriteAppSettings({ defaultProvider: nextValue }).catch(
      (error) => {
        setAppSettingsError(
          error instanceof Error
            ? error.message
            : "Unable to save provider settings.",
        );
      },
    );
  }

  function handleQueueDeliveryModeChange(nextValue: "queue" | "steer") {
    void handleWriteAppSettings({ queueDeliveryMode: nextValue }).catch(
      (error) => {
        setAppSettingsError(
          error instanceof Error
            ? error.message
            : "Unable to save message delivery settings.",
        );
      },
    );
  }

  async function handleCodexManagerEnabledChange(enabled: boolean) {
    if (codexManagerPending) return;
    setCodexManagerPending(true);
    setCodexManagerError(null);
    try {
      const response = await fetch(
        `/api/codex-manager/${enabled ? "activate" : "disable"}`,
        {
          method: "POST",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as
        | CodexManagerGatewaySnapshot
        | { snapshot?: CodexManagerGatewaySnapshot };
      const snapshot = ("snapshot" in payload ? payload.snapshot : payload) as
        CodexManagerGatewaySnapshot | undefined;
      setCodexManagerGateway(snapshot ?? null);
      await state.handleReadAppSettings();
    } catch (error) {
      setCodexManagerError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setCodexManagerPending(false);
    }
  }

  const handleCodexManagerLoginCompleted = useCallback(async (accountName: string) => {
    // A completed device login replaces credentials. Do not render the old
    // quota sample as if it belonged to the new token: block until the live
    // account check has written its new safe status projection.
    const response = await fetch(`/api/codex-manager/accounts/${encodeURIComponent(accountName)}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ forceRefresh: true }),
    });
    if (!response.ok) throw new Error(await response.text());
    // Scan after sign-in as well, so the account ↔ Chrome association reflects
    // the profile used for the just-completed login.
    const scan = await fetch("/api/codex-manager/browser/scan", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (!scan.ok) throw new Error(await scan.text());
    await state.handleReadAppSettings();
    setCodexManagerRefreshKey((current) => current + 1);
  }, [state.handleReadAppSettings]);

  async function activateCustomProvider(providerID: string) {
    setAppSettingsError(null);
    await handleWriteAppSettings({
      codexBackend: {
        mode: "custom",
        enabled: true,
        customProviderId: providerID,
      },
    });
  }

  function handleCommitMessageProviderChange(provider: AgentProvider) {
    const providerConfig = providerCatalogEntry(provider);
    const model =
      providerConfig.defaultModel || providerConfig.models[0]?.id || "";
    void handleWriteAppSettings({
      commitMessageGenerator: { provider, model },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save commit message generator.",
      );
    });
  }

  function handleCommitMessageModelChange(model: string) {
    void handleWriteAppSettings({
      commitMessageGenerator: { model },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save commit message generator.",
      );
    });
  }

  function handleProviderDefaultModelChange(
    provider: AgentProvider,
    model: string,
  ) {
    setProviderDefaultModel(provider, model);
    void handleWriteAppSettings({
      providerDefaults: { [provider]: { model, modelMode: "manual" } },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save provider settings.",
      );
    });
  }

  function handleProviderDefaultModelModeChange(
    provider: AgentProvider,
    modelMode: "auto" | "manual",
  ) {
    void handleWriteAppSettings({
      providerDefaults: { [provider]: { modelMode } },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save provider settings.",
      );
    });
  }

  function handleProviderDefaultModelOptionsChange(
    provider: AgentProvider,
    modelOptions: Partial<
      (typeof providerDefaults)[typeof provider]["modelOptions"]
    >,
  ) {
    setProviderDefaultModelOptions(provider, modelOptions);
    void handleWriteAppSettings({
      providerDefaults: {
        [provider]: { modelOptions, reasoningEffortMode: "manual" },
      },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save provider settings.",
      );
    });
  }

  function handleProviderDefaultReasoningEffortModeChange(
    provider: AgentProvider,
    reasoningEffortMode: "auto" | "manual",
  ) {
    void handleWriteAppSettings({
      providerDefaults: { [provider]: { reasoningEffortMode } },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save provider settings.",
      );
    });
  }

  function handleProviderDefaultPlanModeChange(
    provider: AgentProvider,
    planMode: boolean,
  ) {
    setProviderDefaultPlanMode(provider, planMode);
    void handleWriteAppSettings({
      providerDefaults: { [provider]: { planMode } },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save provider settings.",
      );
    });
  }

  function handleProviderExecutableDraftChange(
    provider: AgentProvider,
    executable: string,
  ) {
    setProviderExecutableDrafts((drafts) => ({
      ...drafts,
      [provider]: executable,
    }));
  }

  function commitProviderExecutable(provider: AgentProvider) {
    void handleWriteAppSettings({
      providerExecutables: {
        [provider]: (providerExecutableDrafts[provider] ?? "").trim(),
      },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save provider executable.",
      );
    });
  }

  function providerCatalogEntry(provider: AgentProvider) {
    return findProviderCatalogEntry(settingsAvailableProviders, provider);
  }

  function providerModelInventory(provider: AgentProvider) {
    return (
      providerModelCatalog?.[provider] ?? {
        catalogModels: [],
        discoveredModels: [],
        customModels: [],
      }
    );
  }

  async function handleRefreshProviderModels() {
    try {
      setModelRefreshStatus("loading");
      setAppSettingsError(null);
      await state.socket.command({ type: "settings.refreshProviderModels" });
      await state.handleReadAppSettings();
      setModelRefreshStatus("success");
    } catch (error) {
      setModelRefreshStatus("idle");
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to refresh provider models.",
      );
    }
  }

  function persistProviderModelCatalog(
    provider: AgentProvider,
    models: ProviderModelOption[],
  ) {
    const normalized = normalizeEditableProviderModels(provider, models);
    setModelCatalogDrafts((drafts) => ({
      ...drafts,
      [provider]: cloneProviderModelOptions(normalized),
    }));
    void handleWriteAppSettings({
      providerModelCatalog: {
        [provider]: { catalogModels: normalized, customModels: [] },
      } as AppSettingsPatch["providerModelCatalog"],
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save model catalog.",
      );
    });
  }

  function handleModelCatalogDraftChange(
    provider: AgentProvider,
    index: number,
    field: "id" | "label",
    value: string,
  ) {
    setModelCatalogDrafts((drafts) => ({
      ...drafts,
      [provider]: (drafts[provider] ?? []).map((model, modelIndex) =>
        modelIndex === index ? { ...model, [field]: value } : model,
      ),
    }));
  }

  function handleModelCatalogInputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
  ) {
    if (event.key !== "Enter") return;
    event.currentTarget.blur();
  }

  function handleNewModelCatalogDraftChange(
    provider: AgentProvider,
    field: "id" | "label",
    value: string,
  ) {
    setNewModelCatalogDrafts((drafts) => ({
      ...drafts,
      [provider]: { ...drafts[provider], [field]: value },
    }));
  }

  function buildProviderModelOption(
    provider: AgentProvider,
    modelId: string,
    label: string,
  ): ProviderModelOption {
    return {
      id: modelId,
      label: label.trim() || modelId,
      supportsEffort: provider === "claude",
    };
  }

  function handleAddProviderModel(provider: AgentProvider) {
    const draft = newModelCatalogDrafts[provider];
    const modelId = draft.id.trim();
    if (!modelId) return;
    const current = normalizeEditableProviderModels(
      provider,
      modelCatalogDrafts[provider] ?? providerCatalogEntry(provider).models,
    );
    const nextModel = buildProviderModelOption(provider, modelId, draft.label);
    const nextModels = [
      ...current.filter((model) => model.id !== modelId),
      nextModel,
    ];
    setNewModelCatalogDrafts((drafts) => ({
      ...drafts,
      [provider]: { id: "", label: "" },
    }));
    setProviderDefaultModel(provider, modelId);
    void handleWriteAppSettings({
      providerModelCatalog: {
        [provider]: { catalogModels: nextModels, customModels: [] },
      } as AppSettingsPatch["providerModelCatalog"],
      providerDefaults: {
        [provider]: { model: modelId, modelMode: "manual" },
      } as AppSettingsPatch["providerDefaults"],
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save model catalog.",
      );
    });
  }

  function handleRemoveProviderModel(provider: AgentProvider, modelId: string) {
    const removal = providerModelCatalogRemoval(
      provider,
      modelId,
      modelCatalogDrafts[provider] ?? [],
      providerDefaults[provider].model,
    );
    if (!removal) return;
    setModelCatalogDrafts((drafts) => ({
      ...drafts,
      [provider]: cloneProviderModelOptions(removal.models),
    }));
    const nextDefaultModel = removal.patch.providerDefaults?.[provider]?.model;
    if (nextDefaultModel) setProviderDefaultModel(provider, nextDefaultModel);
    void handleWriteAppSettings(removal.patch).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to remove provider model.",
      );
    });
  }

  function resetProviderModelCatalog(provider: AgentProvider) {
    void handleWriteAppSettings(providerModelCatalogResetPatch(provider)).catch(
      (error) => {
        setAppSettingsError(
          error instanceof Error
            ? error.message
            : "Unable to reset model catalog.",
        );
      },
    );
  }

  function handleProviderProxyModeChange(mode: ProviderProxyMode) {
    void handleWriteAppSettings({
      providerProxy: {
        mode,
        httpProxy: providerProxyHttpDraft,
        noProxy: providerProxyNoProxyDraft,
      },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save proxy settings.",
      );
    });
  }

  function commitProviderProxySettings() {
    void handleWriteAppSettings({
      providerProxy: {
        mode: appSettings?.providerProxy.mode ?? "none",
        httpProxy: providerProxyHttpDraft,
        noProxy: providerProxyNoProxyDraft,
      },
    }).catch((error) => {
      setAppSettingsError(
        error instanceof Error
          ? error.message
          : "Unable to save proxy settings.",
      );
    });
  }

  async function commitKeybindings() {
    try {
      setKeybindingsError(null);
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(keybindingDrafts),
      });
    } catch (error) {
      setKeybindingsError(
        error instanceof Error ? error.message : "Unable to save keybindings.",
      );
    }
  }

  async function restoreDefaultKeybinding(
    action: keyof typeof KEYBINDING_ACTION_LABELS,
  ) {
    const nextDrafts = {
      ...keybindingDrafts,
      [action]: formatKeybindingInput(DEFAULT_KEYBINDINGS[action]),
    };
    setKeybindingDrafts(nextDrafts);

    try {
      setKeybindingsError(null);
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(nextDrafts),
      });
    } catch (error) {
      setKeybindingsError(
        error instanceof Error ? error.message : "Unable to save keybindings.",
      );
    }
  }

  async function commitLlmProvider(nextValue = llmProviderDraft) {
    try {
      setLlmProviderError(null);
      await handleWriteLlmProvider(nextValue);
      const validation = await handleValidateLlmProvider(nextValue);
      setLlmValidationStatus(validation.ok ? "valid" : "invalid");
      setLlmValidationError(validation.error);
    } catch (error) {
      const fallbackError =
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error;
      setLlmValidationStatus("invalid");
      setLlmValidationError(fallbackError);
      setLlmProviderError(
        error instanceof Error
          ? error.message
          : "Unable to save quick response provider settings.",
      );
    }
  }

  function handleLlmProviderSelection(nextProvider: LlmProviderKind) {
    const nextDraft = {
      ...llmProviderDraft,
      provider: nextProvider,
      model:
        nextProvider === "openai"
          ? DEFAULT_OPENAI_SDK_MODEL
          : nextProvider === "openrouter"
            ? DEFAULT_OPENROUTER_SDK_MODEL
            : llmProviderDraft.model,
      baseUrl: nextProvider === "custom" ? llmProviderDraft.baseUrl : "",
    };
    setLlmProviderDraft(nextDraft);
    void commitLlmProvider(nextDraft);
  }

  function retryChangelog() {
    changelogCache = null;
    setChangelogStatus("loading");
    setChangelogError(null);

    void loadChangelog({ force: true })
      .then((nextReleases) => {
        setReleases(nextReleases);
        setChangelogStatus("success");
      })
      .catch((error: unknown) => {
        setChangelogError(
          error instanceof Error ? error.message : "Unable to load changelog.",
        );
        setChangelogStatus("error");
      });
  }

  function renderModelCatalogControls(provider: AgentProvider) {
    const providerConfig = providerCatalogEntry(provider);
    const inventory = providerModelInventory(provider);
    const models = modelCatalogDrafts[provider]?.length
      ? modelCatalogDrafts[provider]
      : cloneProviderModelOptions(providerConfig.models);
    const newDraft = newModelCatalogDrafts[provider];
    return (
      <div className="mt-3 flex w-full min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {dictionary.settings.modelCatalogModelCount(models.length)}
          </span>
          <span>
            {dictionary.settings.discoveredModelsCount(
              inventory.discoveredModels?.length ?? 0,
            )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => resetProviderModelCatalog(provider)}
            className="h-7 px-2 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {dictionary.settings.resetModelCatalog}
          </Button>
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_auto]">
          <Input
            type="text"
            value={newDraft.id}
            onChange={(event) =>
              handleNewModelCatalogDraftChange(
                provider,
                "id",
                event.target.value,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") handleAddProviderModel(provider);
            }}
            placeholder={dictionary.settings.modelIdPlaceholder(
              providerConfig.label,
            )}
            aria-label={dictionary.settings.modelCatalogId}
            className="h-8 min-w-0 font-mono text-xs"
            dir="ltr"
          />
          <Input
            type="text"
            value={newDraft.label}
            onChange={(event) =>
              handleNewModelCatalogDraftChange(
                provider,
                "label",
                event.target.value,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") handleAddProviderModel(provider);
            }}
            placeholder={dictionary.settings.modelLabelPlaceholder}
            aria-label={dictionary.settings.modelCatalogLabel}
            className="h-8 min-w-0 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleAddProviderModel(provider)}
            disabled={!newDraft.id.trim()}
            className="h-8 shrink-0 gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {dictionary.common.add}
          </Button>
        </div>
        <div className="grid max-h-64 min-w-0 gap-1.5 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
          <div className="hidden grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_2rem] gap-2 px-1 text-[11px] font-medium text-muted-foreground sm:grid">
            <span>{dictionary.settings.modelCatalogId}</span>
            <span>{dictionary.settings.modelCatalogLabel}</span>
            <span />
          </div>
          {models.map((model, index) => (
            <div
              key={`${provider}-${index}`}
              className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_2rem]"
            >
              <Input
                type="text"
                value={model.id}
                onChange={(event) =>
                  handleModelCatalogDraftChange(
                    provider,
                    index,
                    "id",
                    event.target.value,
                  )
                }
                onBlur={() =>
                  persistProviderModelCatalog(
                    provider,
                    modelCatalogDrafts[provider] ?? [],
                  )
                }
                onKeyDown={handleModelCatalogInputKeyDown}
                aria-label={dictionary.settings.modelCatalogId}
                className="h-8 min-w-0 font-mono text-xs"
                dir="ltr"
              />
              <Input
                type="text"
                value={model.label}
                onChange={(event) =>
                  handleModelCatalogDraftChange(
                    provider,
                    index,
                    "label",
                    event.target.value,
                  )
                }
                onBlur={() =>
                  persistProviderModelCatalog(
                    provider,
                    modelCatalogDrafts[provider] ?? [],
                  )
                }
                onKeyDown={handleModelCatalogInputKeyDown}
                aria-label={dictionary.settings.modelCatalogLabel}
                className="h-8 min-w-0 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveProviderModel(provider, model.id)}
                disabled={models.length <= 1}
                aria-label={dictionary.settings.removeModel(model.id)}
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const customEditorPreview = editorCommandDraft
    .replaceAll(
      "{path}",
      "/Users/jake/Projects/abolqasem/src/client/app/App.tsx",
    )
    .replaceAll("{line}", "12")
    .replaceAll("{column}", "1");
  const providerProxy = appSettings?.providerProxy ?? {
    mode: "none" as ProviderProxyMode,
    httpProxy: "",
    noProxy: "",
  };
  const selectedSection =
    localizedSidebarItems.find((item) => item.id === selectedPage) ??
    localizedSidebarItems[0];
  const selectedSectionSubtitle =
    selectedPage === "keybindings"
      ? dictionary.settings.keybindingsSubtitle
      : selectedSection.subtitle;
  const showFooter = !isConnecting;
  const llmValidationErrorText = llmValidationError
    ? JSON.stringify(llmValidationError, null, 2)
    : "";
  const llmValidationDescription = (
    <>
      <span>
        {dictionary.settings.quickResponseDescription(
          llmProvider?.filePathDisplay ?? "the active llm-provider.json file",
        )}
      </span>
      <span
        className={cn(
          "mt-2 block text-sm font-medium",
          llmValidationStatus === "valid"
            ? "text-emerald-600 dark:text-emerald-400"
            : llmValidationStatus === "invalid"
              ? "text-destructive"
              : "hidden",
        )}
      >
        {llmValidationStatus === "valid" ? (
          "Credentials valid & saved"
        ) : llmValidationStatus === "invalid" ? (
          <>
            <span>Credentials invalid.</span>
            {llmValidationError ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => setLlmValidationDialogOpen(true)}
                  className="underline underline-offset-2"
                >
                  See error
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </span>
    </>
  );

  async function handleSidebarSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await state.handleSignOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="relative flex h-full flex-1 min-w-0 bg-background">
      <div className="flex min-w-0 flex-1">
        <aside
          className={`hidden w-[200px] shrink-0 md:block ${showFooter ? "pb-[89px]" : ""}`}
        >
          <div className="flex flex-col gap-1 px-4 py-6">
            <div className="px-3 pb-5 text-[22px] font-extrabold tracking-[-0.5px] text-foreground">
              {dictionary.settings.settings}
            </div>
            {localizedSidebarItems.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => navigate(settingsRoute(item.id))}
                className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${
                  item.id === selectedPage
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </div>
              </button>
            ))}
            {authEnabled ? (
              <button
                type="button"
                onClick={() => {
                  void handleSidebarSignOut();
                }}
                disabled={signingOut}
                className="cursor-pointer rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-center gap-2.5">
                  <LogOut className="h-4 w-4 shrink-0" />
                  <span>
                    {signingOut
                      ? dictionary.settings.signingOut
                      : dictionary.settings.signOut}
                  </span>
                </div>
              </button>
            ) : null}
          </div>
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto [direction:ltr]">
          <div
            className="border-b border-border py-2 md:hidden"
            dir={direction}
          >
            <div className="overflow-x-auto pe-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex min-w-max items-center gap-2">
                <div
                  className={cn(
                    "sticky start-0 px-2 py-1",
                    direction === "rtl"
                      ? "bg-gradient-to-l"
                      : "bg-gradient-to-r",
                    "from-background via-background/80 to-transparent",
                  )}
                >
                  <button
                    type="button"
                    onClick={state.openSidebar}
                    className="flex shrink-0 items-center p-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    aria-label={dictionary.settings.openSidebar}
                    title={dictionary.settings.openSidebar}
                  >
                    <Menu className="h-4 w-4 shrink-0" />
                  </button>
                </div>
                {localizedSidebarItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => navigate(settingsRoute(item.id))}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      item.id === selectedPage
                        ? "border-transparent bg-muted font-medium text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                ))}
                {authEnabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSidebarSignOut();
                    }}
                    disabled={signingOut}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">
                      {signingOut
                        ? dictionary.settings.signingOut
                        : dictionary.settings.signOut}
                    </span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div
            className="w-full px-4 pb-32 pt-8 md:px-6 md:pt-16"
            dir={direction}
          >
            {showSettingsContentLoading ? (
              <SettingsContentPlaceholder
                locale={locale}
                error={null}
                onRetry={() => {
                  void state.handleReadAppSettings();
                }}
              />
            ) : appSettingsHydrationStatus === "error" && !appSettings ? (
              <SettingsContentPlaceholder
                locale={locale}
                error={
                  state.commandError ??
                  (locale === "fa"
                    ? "تنظیمات از سرویس محلی دریافت نشد."
                    : "Settings could not be retrieved from the local service.")
                }
                onRetry={() => {
                  void state.handleReadAppSettings();
                }}
              />
            ) : (
              <div className="mx-auto max-w-4xl">
                <div className="pb-6">
                  <div className="flex items-center justify-between gap-4 min-h-[34px]">
                    <div className="text-lg font-semibold tracking-[-0.2px] text-foreground">
                      {selectedSection.label}
                    </div>
                    {selectedPage === "general" ? (
                      <SettingsHeaderButton
                        variant="outline"
                        onClick={() => navigate(settingsRoute("changelog"))}
                      >
                        {dictionary.settings.checkForUpdates}
                      </SettingsHeaderButton>
                    ) : null}
                    {selectedPage === "keybindings" ? (
                      <SettingsHeaderButton
                        onClick={() => {
                          void state.handleOpenExternalPath(
                            "open_editor",
                            keybindingsFilePathDisplay,
                          );
                        }}
                        icon={<Code className="h-4 w-4" />}
                      >
                        {dictionary.settings.openInEditor(state.editorLabel)}
                      </SettingsHeaderButton>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {selectedSectionSubtitle}
                  </div>
                </div>

                {selectedPage === "general" ? (
                  <>
                    {appSettingsError ? (
                      <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {appSettingsError}
                      </div>
                    ) : null}
                    <div className="border-b border-border">
                      <SettingsRow
                        title={dictionary.settings.applicationUpdate}
                        description={
                          <>
                            <span>{updateStatusLabel}.</span>
                            {updateSnapshot?.lastCheckedAt ? (
                              <span>
                                {" "}
                                {dictionary.settings.lastCheckedAt(
                                  new Intl.DateTimeFormat(
                                    locale === "fa" ? "fa-IR" : undefined,
                                    {
                                      month: "short",
                                      day: "numeric",
                                      hour: "numeric",
                                      minute: "2-digit",
                                    },
                                  ).format(updateSnapshot.lastCheckedAt),
                                )}
                              </span>
                            ) : null}
                            {updateSnapshot?.error ? (
                              <span> {updateSnapshot.error}</span>
                            ) : null}
                          </>
                        }
                        bordered={false}
                      >
                        <div className="text-end text-sm text-foreground">
                          <div>
                            {dictionary.settings.current}:{" "}
                            {updateSnapshot?.currentVersion ?? appVersion}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {dictionary.settings.latest}:{" "}
                            {updateSnapshot?.latestVersion ??
                              dictionary.common.unknown}
                          </div>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.languageTitle}
                        description={dictionary.settings.languageDescription}
                      >
                        <Select
                          value={locale}
                          onValueChange={(value) =>
                            handleLocaleChange(value as AppLocale)
                          }
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {LOCALE_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {dictionary.language[option.labelKey]}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.chatSounds}
                        description={dictionary.settings.chatSoundsDescription}
                      >
                        <Select
                          value={chatSoundPreference}
                          onValueChange={(value) =>
                            handleChatSoundPreferenceChange(
                              value as ChatSoundPreference,
                            )
                          }
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {localizedChatSoundPreferenceOptions.map(
                                (option) => (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </SelectItem>
                                ),
                              )}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.chatSound}
                        description={dictionary.settings.chatSoundDescription}
                      >
                        <Select
                          value={chatSoundId}
                          onValueChange={(value) =>
                            handleChatSoundIdChange(value as ChatSoundId)
                          }
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {localizedChatSoundOptions.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </SettingsRow>

                      <SettingsRow
                        anchorId={HOOK_NOTIFICATION_SETTINGS_HASH}
                        title={dictionary.settings.hookNotifications}
                        description={
                          dictionary.settings.hookNotificationsDescription
                        }
                      >
                        <SegmentedControl
                          value={
                            appSettings?.management?.hookNotifications.enabled
                              ? "enabled"
                              : "disabled"
                          }
                          onValueChange={(value) => {
                            void handleManagementPreferenceChange({
                              hookUpdates: value === "enabled",
                            });
                          }}
                          options={localizedHookEnabledOptions}
                          size="sm"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.hookFollowMode}
                        description={
                          dictionary.settings.hookFollowModeDescription
                        }
                      >
                        <SegmentedControl
                          value={
                            appSettings?.management?.hookNotifications
                              .followMode ?? "auto"
                          }
                          onValueChange={(value) => {
                            void handleManagementPreferenceChange({
                              hookFollowMode: value as
                                "auto" | "notice" | "off",
                            });
                          }}
                          options={localizedHookFollowOptions}
                          size="sm"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.filesystemDiscovery}
                        description={
                          dictionary.settings.filesystemDiscoveryDescription
                        }
                      >
                        <SegmentedControl
                          value={
                            appSettings?.management?.hookNotifications
                              .filesystemDiscovery
                              ? "enabled"
                              : "disabled"
                          }
                          onValueChange={(value) => {
                            void handleManagementPreferenceChange({
                              filesystemDiscovery: value === "enabled",
                            });
                          }}
                          options={localizedHookEnabledOptions}
                          size="sm"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.reloadSessions}
                        description={
                          dictionary.settings.filesystemDiscoveryDescription
                        }
                      >
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handleReloadSessions()}
                          >
                            {dictionary.settings.reloadSessions}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handleRestartServer()}
                          >
                            {dictionary.settings.restartServer}
                          </Button>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.defaultEditor}
                        description={
                          dictionary.settings.defaultEditorDescription
                        }
                        alignStart
                      >
                        <Select
                          value={editorPreset}
                          onValueChange={(value) =>
                            handleEditorPresetChange(value as EditorPreset)
                          }
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {EDITOR_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  <span className="flex items-center gap-2">
                                    <EditorIcon
                                      preset={option.value}
                                      className="h-4 w-4 shrink-0"
                                    />
                                    <span>{option.label}</span>
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </SettingsRow>

                      {editorPreset === "custom" ? (
                        <div className="border-t border-border">
                          <div className="flex justify-between gap-8 py-5 ps-6">
                            <div className="min-w-0 max-w-xl">
                              <div className="text-sm font-medium text-foreground">
                                {dictionary.settings.commandTemplate}
                              </div>
                              <div className="mt-1 text-[13px] text-muted-foreground">
                                {dictionary.settings.commandTemplateDescription}
                              </div>
                            </div>
                            <div className="flex min-w-0 max-w-[420px] flex-1 flex-col items-stretch gap-2">
                              <Input
                                type="text"
                                value={editorCommandDraft}
                                onChange={(event) =>
                                  setEditorCommandDraft(event.target.value)
                                }
                                onBlur={commitEditorCommand}
                                onKeyDown={(event) =>
                                  handleTextInputKeyDown(
                                    event,
                                    commitEditorCommand,
                                  )
                                }
                                className="font-mono"
                              />
                              <div className="text-xs text-muted-foreground">
                                {dictionary.settings.preview}:{" "}
                                <span className="font-mono">
                                  {customEditorPreview}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <SettingsRow
                        title={dictionary.settings.terminalScrollback}
                        description={
                          dictionary.settings.terminalScrollbackDescription
                        }
                      >
                        <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
                          <Input
                            type="number"
                            min={MIN_TERMINAL_SCROLLBACK}
                            max={MAX_TERMINAL_SCROLLBACK}
                            step={100}
                            value={scrollbackDraft}
                            onChange={(event) =>
                              setScrollbackDraft(event.target.value)
                            }
                            onBlur={commitScrollback}
                            onKeyDown={(event) =>
                              handleNumberInputKeyDown(event, commitScrollback)
                            }
                            className="hide-number-steppers w-full text-start font-mono md:w-28 md:text-end"
                          />
                          <div className="text-start text-xs text-muted-foreground md:text-end">
                            {MIN_TERMINAL_SCROLLBACK}-{MAX_TERMINAL_SCROLLBACK}{" "}
                            lines
                            {scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK
                              ? ` (${dictionary.settings.defaultSuffix})`
                              : ""}
                          </div>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title={dictionary.settings.terminalMinColumnWidth}
                        description={
                          dictionary.settings.terminalMinColumnWidthDescription
                        }
                      >
                        <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
                          <Input
                            type="number"
                            min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
                            max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
                            step={10}
                            value={minColumnWidthDraft}
                            onChange={(event) =>
                              setMinColumnWidthDraft(event.target.value)
                            }
                            onBlur={commitMinColumnWidth}
                            onKeyDown={(event) =>
                              handleNumberInputKeyDown(
                                event,
                                commitMinColumnWidth,
                              )
                            }
                            className="hide-number-steppers w-full text-start font-mono md:w-28 md:text-end"
                          />
                          <div className="text-start text-xs text-muted-foreground md:text-end">
                            {MIN_TERMINAL_MIN_COLUMN_WIDTH}-
                            {MAX_TERMINAL_MIN_COLUMN_WIDTH} px
                            {minColumnWidth ===
                            DEFAULT_TERMINAL_MIN_COLUMN_WIDTH
                              ? ` (${dictionary.settings.defaultSuffix})`
                              : ""}
                          </div>
                        </div>
                      </SettingsRow>
                    </div>
                  </>
                ) : selectedPage === "telegram" && !telegramLoaded ? (
                  <div
                    className="flex min-h-52 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
                    dir={direction}
                  >
                    {telegramLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    <span>
                      {telegramLoading
                        ? locale === "fa"
                          ? "در حال بازیابی تنظیمات تلگرام…"
                          : "Restoring Telegram settings…"
                        : (telegramError ??
                          (locale === "fa"
                            ? "تنظیمات تلگرام بارگیری نشد."
                            : "Telegram settings could not be loaded"))}
                    </span>
                    {!telegramLoading ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setTelegramError(null);
                          void refreshTelegram().catch((error: unknown) =>
                            setTelegramError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                          );
                        }}
                      >
                        {locale === "fa" ? "تلاش دوباره" : "Retry"}
                      </Button>
                    ) : null}
                  </div>
                ) : selectedPage === "telegram" ? (
                  <div className="border-b border-border" dir={direction}>
                    {telegramError ? (
                      <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {telegramError}
                      </div>
                    ) : null}
                    {telegramNotice ? (
                      <div className="mb-4 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                        {telegramNotice}
                      </div>
                    ) : null}
                    <SettingsRow
                      title={locale === "fa" ? "پل تلگرام" : "Telegram bridge"}
                      description={
                        locale === "fa"
                          ? "فقط کاربران مجاز می‌توانند از ربات استفاده کنند. برای دیدن و انتخاب چت‌ها در تلگرام دستور /chats را بفرستید."
                          : "Only allowlisted users can use the bridge. In Telegram, use /chats to see and select recent chats, or send a message to create one automatically."
                      }
                      bordered={false}
                    >
                      <div className="text-sm text-muted-foreground">
                        {telegramStatus?.active
                          ? locale === "fa"
                            ? "فعال"
                            : "Active"
                          : telegramStatus?.configured
                            ? locale === "fa"
                              ? "تنظیم شده؛ در حال راه‌اندازی"
                              : "Configured; starting"
                            : locale === "fa"
                              ? "تنظیم نشده"
                              : "Not configured"}
                      </div>
                    </SettingsRow>
                    <SettingsRow
                      title={
                        locale === "fa" ? "وضعیت عملیاتی" : "Operational status"
                      }
                      description={
                        locale === "fa"
                          ? "وضعیت gateway، worker، store محلی و ورود فعلی. برای حفظ امنیت، token و مسیرهای حساس نمایش داده نمی‌شوند."
                          : "Gateway, worker, local store, and current-login status. Tokens and sensitive paths are never shown."
                      }
                    >
                      <div className="grid w-full max-w-2xl gap-2 text-xs sm:grid-cols-2">
                        <span
                          className={
                            codexManagerGateway?.diagnostics?.store?.ready
                              ? "rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-emerald-700 dark:text-emerald-300"
                              : "rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-destructive"
                          }
                        >
                          {locale === "fa" ? "Store: " : "Store: "}
                          {codexManagerGateway?.diagnostics?.store?.message ??
                            "—"}
                        </span>
                        <span
                          className={
                            codexManagerGateway?.diagnostics?.liveAuth?.present
                              ? "rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-emerald-700 dark:text-emerald-300"
                              : "rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300"
                          }
                        >
                          {locale === "fa" ? "ورود Codex: " : "Codex login: "}
                          {codexManagerGateway?.diagnostics?.liveAuth
                            ?.message ?? "—"}
                        </span>
                        <span
                          className={
                            codexManagerGateway?.diagnostics?.worker?.running
                              ? "rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-emerald-700 dark:text-emerald-300"
                              : "rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300"
                          }
                        >
                          {locale === "fa" ? "Worker: " : "Worker: "}
                          {codexManagerGateway?.diagnostics?.worker?.running
                            ? locale === "fa"
                              ? "در حال اجرا"
                              : "running"
                            : locale === "fa"
                              ? "متوقف"
                              : "stopped"}
                          {codexManagerGateway?.diagnostics?.worker?.lastError
                            ? ` · ${codexManagerGateway.diagnostics.worker.lastError}`
                            : ""}
                        </span>
                        <span className="rounded border border-border bg-muted/30 px-2 py-1.5 text-muted-foreground">
                          {locale === "fa" ? "Gateway: " : "Gateway: "}
                          {codexManagerGateway?.gateway?.state ?? "stopped"}
                          {codexManagerGateway?.gateway?.crashCount
                            ? ` · ${codexManagerGateway.gateway.crashCount} crashes`
                            : ""}
                        </span>
                      </div>
                    </SettingsRow>
                    <SettingsRow
                      title={locale === "fa" ? "توکن ربات" : "Bot token"}
                      description={
                        locale === "fa"
                          ? "به‌صورت محلی و با دسترسی محدود به مالک ذخیره می‌شود."
                          : "Stored locally with owner-only file permissions."
                      }
                    >
                      <Input
                        dir="ltr"
                        className="font-mono text-left"
                        type="password"
                        value={telegramDraft.botToken}
                        onChange={(event) =>
                          setTelegramDraft((current) => ({
                            ...current,
                            botToken: event.target.value,
                          }))
                        }
                        placeholder="123456:token"
                      />
                    </SettingsRow>
                    <SettingsRow
                      title={
                        locale === "fa"
                          ? "شناسهٔ کاربران مجاز"
                          : "Allowed user IDs"
                      }
                      description={
                        locale === "fa"
                          ? "شناسه‌های عددی تلگرام را با ویرگول جدا کنید؛ * یعنی همهٔ کاربران."
                          : "Comma-separated Telegram numeric IDs, or * for all users."
                      }
                    >
                      <Input
                        dir="ltr"
                        className="font-mono text-left"
                        value={telegramDraft.allowedUserIds}
                        onChange={(event) =>
                          setTelegramDraft((current) => ({
                            ...current,
                            allowedUserIds: event.target.value,
                          }))
                        }
                        placeholder="123456789"
                      />
                    </SettingsRow>
                    <SettingsRow
                      title={
                        locale === "fa" ? "پروکسی تلگرام" : "Telegram proxy"
                      }
                      description={
                        locale === "fa"
                          ? "برای دریافت و ارسال پیام لازم است؛ HTTP، HTTPS، SOCKS5 و SOCKS5H پشتیبانی می‌شوند."
                          : "Required for polling and sending. Supports HTTP, HTTPS, SOCKS5, and SOCKS5H."
                      }
                    >
                      <Input
                        dir="ltr"
                        className="font-mono text-left"
                        value={telegramDraft.proxyUrl}
                        onChange={(event) =>
                          setTelegramDraft((current) => ({
                            ...current,
                            proxyUrl: event.target.value,
                          }))
                        }
                        placeholder="socks5://127.0.0.1:10810"
                      />
                    </SettingsRow>
                    <SettingsRow
                      title={
                        locale === "fa"
                          ? "فرمان‌های سفارشی سیستم"
                          : "Custom system commands"
                      }
                      description={
                        locale === "fa"
                          ? "کاربران مجاز فقط همین فرمان‌های ازپیش‌تعریف‌شده را با /run <name> اجرا می‌کنند؛ آرگومان دلخواه از تلگرام پذیرفته نمی‌شود."
                          : "Only allowlisted Telegram users may run these exact commands with /run <name>. Arguments from Telegram are never accepted."
                      }
                    >
                      <div className="grid w-full max-w-4xl gap-2">
                        {telegramDraft.customCommands.map((command, index) => (
                          <fieldset
                            key={index}
                            className="rounded-xl border border-border/80 bg-muted/10 p-3"
                            dir={direction}
                          >
                            <legend className="sr-only">
                              {locale === "fa"
                                ? `فرمان ${index + 1}`
                                : `Command ${index + 1}`}
                            </legend>
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                                  {locale === "fa"
                                    ? `فرمان ${index + 1}`
                                    : `Command ${index + 1}`}
                                </span>
                                <code
                                  dir="ltr"
                                  className="truncate text-left text-xs text-muted-foreground"
                                >
                                  /run {command.name.trim() || "name"}
                                </code>
                              </div>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                className="shrink-0"
                                onClick={() =>
                                  removeTelegramCustomCommand(index)
                                }
                                aria-label={
                                  locale === "fa"
                                    ? "حذف فرمان سفارشی تلگرام"
                                    : "Remove custom Telegram command"
                                }
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                            <div className="grid gap-2 lg:grid-cols-[minmax(8rem,0.7fr)_minmax(12rem,1.3fr)_minmax(14rem,2fr)]">
                              <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
                                <span>
                                  {locale === "fa"
                                    ? "نام تلگرام"
                                    : "Telegram name"}
                                </span>
                                <Input
                                  aria-label={
                                    locale === "fa"
                                      ? "نام فرمان تلگرام"
                                      : "Telegram command name"
                                  }
                                  dir="ltr"
                                  className="h-8 font-mono text-left text-xs"
                                  value={command.name}
                                  onChange={(event) =>
                                    updateTelegramCustomCommand(index, {
                                      name: event.target.value.toLowerCase(),
                                    })
                                  }
                                  placeholder="status"
                                />
                              </label>
                              <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
                                <span>
                                  {locale === "fa"
                                    ? "توضیح برای کاربر"
                                    : "User-facing description"}
                                </span>
                                <Input
                                  aria-label={
                                    locale === "fa"
                                      ? "توضیح فرمان تلگرام"
                                      : "Telegram command description"
                                  }
                                  dir={direction}
                                  className={`h-8 text-xs ${direction === "rtl" ? "text-right" : "text-left"}`}
                                  value={command.description}
                                  onChange={(event) =>
                                    updateTelegramCustomCommand(index, {
                                      description: event.target.value,
                                    })
                                  }
                                  placeholder={
                                    locale === "fa"
                                      ? "مثلاً: نمایش وضعیت سرویس"
                                      : "e.g. Show service status"
                                  }
                                />
                              </label>
                              <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
                                <span>
                                  {locale === "fa"
                                    ? "دستور سیستم"
                                    : "System command"}
                                </span>
                                <Input
                                  aria-label={
                                    locale === "fa"
                                      ? "فرمان سیستم"
                                      : "System command"
                                  }
                                  dir="ltr"
                                  className="h-8 font-mono text-left text-xs"
                                  value={command.command}
                                  onChange={(event) =>
                                    updateTelegramCustomCommand(index, {
                                      command: event.target.value,
                                    })
                                  }
                                  placeholder="git status --short"
                                />
                              </label>
                            </div>
                            <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1fr)_7rem]">
                              <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
                                <span>
                                  {locale === "fa"
                                    ? "پوشهٔ اجرا"
                                    : "Working directory"}
                                </span>
                                <Input
                                  aria-label={
                                    locale === "fa"
                                      ? "مسیر اجرای فرمان"
                                      : "Working directory"
                                  }
                                  dir="ltr"
                                  className="h-8 font-mono text-left text-xs"
                                  value={command.workingDirectory}
                                  onChange={(event) =>
                                    updateTelegramCustomCommand(index, {
                                      workingDirectory: event.target.value,
                                    })
                                  }
                                  placeholder="/srv/project (optional)"
                                />
                              </label>
                              <label className="grid gap-1 text-xs font-medium text-foreground">
                                <span>
                                  {locale === "fa"
                                    ? "مهلت (ثانیه)"
                                    : "Timeout (sec)"}
                                </span>
                                <Input
                                  aria-label={
                                    locale === "fa"
                                      ? "مهلت اجرا به ثانیه"
                                      : "Timeout seconds"
                                  }
                                  dir="ltr"
                                  className="h-8 font-mono text-left text-xs"
                                  type="number"
                                  min={1}
                                  max={120}
                                  value={command.timeoutSeconds}
                                  onChange={(event) =>
                                    updateTelegramCustomCommand(index, {
                                      timeoutSeconds:
                                        Number(event.target.value) || 30,
                                    })
                                  }
                                />
                              </label>
                            </div>
                          </fieldset>
                        ))}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="w-fit"
                          onClick={addTelegramCustomCommand}
                        >
                          <Plus className="size-4" />{" "}
                          {locale === "fa" ? "افزودن فرمان" : "Add command"}
                        </Button>
                      </div>
                    </SettingsRow>
                    <SettingsRow
                      title={locale === "fa" ? "اتصال چت‌ها" : "Mappings"}
                      description={
                        locale === "fa"
                          ? "هر چت تلگرام مقصد خود را از فهرست /chats انتخاب می‌کند."
                          : "Each Telegram chat chooses its destination from the /chats picker."
                      }
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm text-muted-foreground">
                          {locale === "fa"
                            ? `${telegramStatus?.mappedChats ?? 0} چت متصل`
                            : `${telegramStatus?.mappedChats ?? 0} connected`}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {telegramStatus?.proxyConfigured
                            ? locale === "fa"
                              ? "پروکسی آماده است"
                              : "Proxy ready"
                            : locale === "fa"
                              ? "پروکسی لازم است"
                              : "Proxy required"}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void saveTelegram()}
                          disabled={telegramSaving}
                        >
                          {telegramSaving
                            ? locale === "fa"
                              ? "در حال ذخیره…"
                              : "Saving…"
                            : locale === "fa"
                              ? "ذخیره و اتصال"
                              : "Save and connect"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void testTelegram()}
                          disabled={
                            telegramTesting ||
                            !canSendTelegramTest(telegramStatus)
                          }
                        >
                          {telegramTesting
                            ? locale === "fa"
                              ? "در حال ارسال…"
                              : "Sending…"
                            : locale === "fa"
                              ? "ارسال پیام آزمایشی"
                              : "Send test"}
                        </Button>
                      </div>
                    </SettingsRow>
                    {telegramStatus?.lastError ? (
                      <div className="px-4 pb-4 text-sm text-destructive">
                        {telegramStatus.lastError}
                      </div>
                    ) : null}
                  </div>
                ) : selectedPage === "codex-manager" ? (
                  <div
                    className="grid gap-4 border-b border-border p-4"
                    dir={direction}
                  >
                    <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <h2 className="text-base font-semibold">
                          {locale === "fa"
                            ? "مدیریت حساب‌های Codex"
                            : "Codex account management"}
                        </h2>
                        <SettingsInfoHint
                          direction={direction}
                          label={
                            locale === "fa"
                              ? "راهنمای مدیریت حساب‌ها"
                              : "Account management help"
                          }
                        >
                          {locale === "fa"
                            ? "حساب فعال را از تب «حساب‌ها» انتخاب کنید. تب‌های دیگر فقط برای خودکارسازی انتخاب حساب، مدیریت Chrome، نمودار مصرف و تنظیمات تخصصی‌اند."
                            : "Choose the active account from Accounts. The other tabs cover automatic selection, Chrome, usage charts, and advanced settings."}
                        </SettingsInfoHint>
                      </div>
                    </div>
                    <div
                      role="tablist"
                      aria-label={
                        locale === "fa"
                          ? "بخش‌های مدیریت Codex"
                          : "Codex Manager sections"
                      }
                      className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-muted/20 p-1"
                    >
                      {(
                        [
                          [
                            "accounts",
                            locale === "fa" ? "حساب‌ها" : "Accounts",
                          ],
                          [
                            "load-balancer",
                            locale === "fa" ? "لود بالانسر" : "Load balancer",
                          ],
                          ["chrome", "Chrome"],
                          ["charts", locale === "fa" ? "نمودارها" : "Charts"],
                          [
                            "advanced",
                            locale === "fa" ? "تنظیمات پیشرفته" : "Advanced",
                          ],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          id={`codex-manager-tab-${id}`}
                          type="button"
                          role="tab"
                          aria-selected={codexManagerTab === id}
                          aria-controls={`codex-manager-panel-${id}`}
                          onClick={() => setCodexManagerTab(id)}
                          className={cn(
                            "shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            codexManagerTab === id
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {codexManagerTab === "accounts" ? (
                      <div
                        id="codex-manager-panel-accounts"
                        role="tabpanel"
                        aria-labelledby="codex-manager-tab-accounts"
                      >
                        <AccountsPanel
                          locale={locale}
                          onAdd={() => {
                            setDeviceLoginAccountName("");
                            setDeviceLoginOpen(true);
                          }}
                          onRelogin={(accountName) => {
                            setDeviceLoginAccountName(accountName);
                            setDeviceLoginOpen(true);
                          }}
                          refreshKey={codexManagerRefreshKey}
                        />
                      </div>
                    ) : null}
                    {codexManagerTab === "load-balancer" ? (
                      <div
                        id="codex-manager-panel-load-balancer"
                        role="tabpanel"
                        aria-labelledby="codex-manager-tab-load-balancer"
                      >
                        <SettingsRow
                          title={
                            <span className="flex items-center gap-1.5">
                              {locale === "fa"
                                ? "انتخاب خودکار حساب (اختیاری)"
                                : "Load-balancer gateway (optional)"}
                              <SettingsInfoHint
                                direction={direction}
                                label={
                                  locale === "fa"
                                    ? "راهنمای انتخاب خودکار حساب"
                                    : "Load-balancer help"
                                }
                              >
                                {locale === "fa"
                                  ? "برای گفت‌وگوهای جدید، حسابی با ظرفیت بهتر را انتخاب می‌کند. روشن یا خاموش بودن آن، مدیریت دستی حساب‌ها را تغییر نمی‌دهد."
                                  : "Selects an account with better capacity for new chats. It never changes manual account management."}
                              </SettingsInfoHint>
                            </span>
                          }
                          description={null}
                        >
                          <div className="flex min-w-[250px] flex-col items-end gap-2">
                            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
                              <input
                                type="checkbox"
                                className="size-4 accent-primary"
                                checked={
                                  codexManagerGateway?.enabled ??
                                  (appSettings?.codexBackend.mode ===
                                    "manager" &&
                                    appSettings.codexBackend.enabled)
                                }
                                disabled={codexManagerPending || isConnecting}
                                onChange={(event) =>
                                  void handleCodexManagerEnabledChange(
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>
                                {codexManagerPending
                                  ? locale === "fa"
                                    ? "در حال اعمال…"
                                    : "Applying…"
                                  : locale === "fa"
                                    ? "فعال‌سازی انتخاب خودکار"
                                    : "Enable load-balancer"}
                              </span>
                              {codexManagerPending ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : null}
                            </label>
                            <p
                              className={cn(
                                "max-w-[380px] text-xs",
                                codexManagerError
                                  ? "text-destructive"
                                  : "text-muted-foreground",
                              )}
                            >
                              {codexManagerError ??
                                codexManagerGateway?.gateway?.lastError ??
                                (codexManagerGateway?.enabled
                                  ? locale === "fa"
                                    ? "انتخاب خودکار برای گفت‌وگوهای جدید فعال است."
                                    : "Load-balancer is active."
                                  : locale === "fa"
                                    ? "خاموش است؛ شما همچنان می‌توانید حساب فعال را خودتان انتخاب کنید."
                                    : "Disabled; account management remains available.")}
                            </p>
                          </div>
                        </SettingsRow>
                        <SettingsRow
                          title={
                            <span className="flex items-center gap-1.5">
                              {locale === "fa"
                                ? "سیاست انتخاب حساب"
                                : "Account selection policy"}
                              <SettingsInfoHint
                                direction={direction}
                                label={
                                  locale === "fa"
                                    ? "راهنمای سیاست انتخاب حساب"
                                    : "Selection policy help"
                                }
                              >
                                {locale === "fa"
                                  ? "«حساب فعال ثابت» همیشه از انتخاب فعلی استفاده می‌کند؛ «انتخاب خودکار» برای هر گفت‌وگوی جدید ظرفیت حساب‌ها را مقایسه می‌کند."
                                  : "Pinned always uses the active account; Automatic compares available capacity for each new chat."}
                              </SettingsInfoHint>
                            </span>
                          }
                          description={null}
                        >
                          <Select
                            value={
                              codexManagerGateway?.autoSwitchPolicy ??
                              appSettings?.codexBackend.autoSwitchPolicy ??
                              "automatic"
                            }
                            onValueChange={(value) =>
                              void handleWriteAppSettings({
                                codexBackend: {
                                  autoSwitchPolicy: value as
                                    "off" | "pinned" | "automatic",
                                },
                              })
                            }
                            disabled={codexManagerPending || isConnecting}
                          >
                            <SelectTrigger className="min-w-44">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent dir={direction}>
                              <SelectItem value="off">
                                {locale === "fa" ? "خاموش" : "Off"}
                              </SelectItem>
                              <SelectItem value="pinned">
                                {locale === "fa"
                                  ? "حساب فعال ثابت"
                                  : "Pinned account"}
                              </SelectItem>
                              <SelectItem value="automatic">
                                {locale === "fa"
                                  ? "انتخاب خودکار بر اساس سهمیه"
                                  : "Automatic by quota"}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </SettingsRow>
                      </div>
                    ) : null}
                    {codexManagerTab === "advanced" ? (
                      <div
                        id="codex-manager-panel-advanced"
                        role="tabpanel"
                        aria-labelledby="codex-manager-tab-advanced"
                      >
                        <SettingsRow
                          title={
                            <span className="flex items-center gap-1.5">
                              {locale === "fa"
                                ? "به‌روزرسانی پس‌زمینهٔ حساب‌ها"
                                : "Background account maintenance"}
                              <SettingsInfoHint
                                direction={direction}
                                label={
                                  locale === "fa"
                                    ? "راهنمای به‌روزرسانی پس‌زمینه"
                                    : "Background maintenance help"
                                }
                              >
                                {locale === "fa"
                                  ? "این زمان‌بندی فقط سهمیه و اعتبار ورود حساب‌ها را به‌روز می‌کند و مدل یا provider گفت‌وگو را تغییر نمی‌دهد."
                                  : "This only refreshes account quota and sign-in status; it does not change your chat model or provider."}
                              </SettingsInfoHint>
                            </span>
                          }
                          description={null}
                        >
                          <fieldset
                            className="grid w-full max-w-2xl gap-3 sm:grid-cols-2"
                            disabled={codexManagerPending || isConnecting}
                          >
                            <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                {locale === "fa"
                                  ? "بازهٔ بررسی سهمیه"
                                  : "Quota check interval"}
                                <SettingsInfoHint
                                  direction={direction}
                                  label={
                                    locale === "fa"
                                      ? "راهنمای بازهٔ بررسی سهمیه"
                                      : "Quota interval help"
                                  }
                                >
                                  {locale === "fa"
                                    ? "۵ تا ۱۵ دقیقه برای آزمایش یا تغییر سریع مناسب است؛ برای استفادهٔ روزمره ۳۰ تا ۶۰ دقیقه کافی است. بازهٔ کوتاه‌تر درخواست بیشتری می‌فرستد."
                                    : "Use 5–15 minutes for testing or rapid changes; 30–60 minutes suits normal use. Shorter intervals make more requests."}
                                </SettingsInfoHint>
                              </span>
                              <Select
                                value={String(
                                  appSettings?.codexBackend.maintenance
                                    .intervalSeconds ?? 3600,
                                )}
                                onValueChange={(value) =>
                                  void handleWriteAppSettings({
                                    codexBackend: {
                                      maintenance: {
                                        intervalSeconds: Number(value),
                                      },
                                    },
                                  })
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent dir={direction}>
                                  <SelectItem value="300">
                                    {locale === "fa"
                                      ? "هر ۵ دقیقه"
                                      : "Every 5 minutes"}
                                  </SelectItem>
                                  <SelectItem value="900">
                                    {locale === "fa"
                                      ? "هر ۱۵ دقیقه"
                                      : "Every 15 minutes"}
                                  </SelectItem>
                                  <SelectItem value="1800">
                                    {locale === "fa"
                                      ? "هر ۳۰ دقیقه"
                                      : "Every 30 minutes"}
                                  </SelectItem>
                                  <SelectItem value="3600">
                                    {locale === "fa"
                                      ? "هر ۱ ساعت"
                                      : "Every hour"}
                                  </SelectItem>
                                  <SelectItem value="7200">
                                    {locale === "fa"
                                      ? "هر ۲ ساعت"
                                      : "Every 2 hours"}
                                  </SelectItem>
                                  <SelectItem value="21600">
                                    {locale === "fa"
                                      ? "هر ۶ ساعت"
                                      : "Every 6 hours"}
                                  </SelectItem>
                                  <SelectItem value="43200">
                                    {locale === "fa"
                                      ? "هر ۱۲ ساعت"
                                      : "Every 12 hours"}
                                  </SelectItem>
                                  <SelectItem value="86400">
                                    {locale === "fa" ? "هر روز" : "Daily"}
                                  </SelectItem>
                                  <SelectItem value="259200">
                                    {locale === "fa"
                                      ? "هر ۳ روز"
                                      : "Every 3 days"}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </label>
                            <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                {locale === "fa"
                                  ? "پروکسی بررسی حساب‌ها (اختیاری)"
                                  : "Check proxy (optional)"}
                                <SettingsInfoHint
                                  direction={direction}
                                  label={
                                    locale === "fa"
                                      ? "راهنمای پروکسی بررسی حساب"
                                      : "Check proxy help"
                                  }
                                >
                                  {locale === "fa"
                                    ? "اگر ChatGPT را فقط با پروکسی باز می‌کنید، همان آدرس را وارد کنید. هم دریافت سهمیه و هم نوسازی ورود از آن استفاده می‌کنند."
                                    : "If ChatGPT requires a proxy on this device, enter it here. Both quota checks and sign-in refresh use it."}
                                </SettingsInfoHint>
                              </span>
                              <Input
                                key={
                                  appSettings?.codexBackend.maintenance
                                    .proxyUrl ?? ""
                                }
                                defaultValue={
                                  appSettings?.codexBackend.maintenance
                                    .proxyUrl ?? ""
                                }
                                dir="ltr"
                                className="h-9 font-mono text-left text-xs"
                                placeholder="http://127.0.0.1:7890"
                                onBlur={(event) =>
                                  void handleWriteAppSettings({
                                    codexBackend: {
                                      maintenance: {
                                        proxyUrl: event.target.value,
                                      },
                                    },
                                  })
                                }
                              />
                            </label>
                          </fieldset>
                        </SettingsRow>
                        <SettingsRow
                          title={
                            <span className="flex items-center gap-1.5">
                              {locale === "fa"
                                ? "مسیر دادهٔ Chrome (اختیاری)"
                                : "Chrome data directory (optional)"}
                              <SettingsInfoHint
                                direction={direction}
                                label={
                                  locale === "fa"
                                    ? "راهنمای مسیر دادهٔ Chrome"
                                    : "Chrome data directory help"
                                }
                              >
                                {locale === "fa"
                                  ? "فقط وقتی Chrome را در مسیر غیرمعمول نصب کرده‌اید این مقدار را وارد کنید. در حالت عادی خالی بماند تا مسیر پیش‌فرض سیستم استفاده شود."
                                  : "Only set this when Chrome uses a nonstandard data directory. Leave it blank to use the system default."}
                              </SettingsInfoHint>
                            </span>
                          }
                          description={null}
                        >
                          <Input
                            key={
                              appSettings?.codexBackend.sessionMonitor
                                ?.chromeRoot ?? ""
                            }
                            defaultValue={
                              appSettings?.codexBackend.sessionMonitor
                                ?.chromeRoot ?? ""
                            }
                            dir="ltr"
                            className="h-9 w-full max-w-xl font-mono text-left text-xs"
                            placeholder={
                              locale === "fa"
                                ? "پیش‌فرض سیستم"
                                : "Use the system default"
                            }
                            disabled={codexManagerPending || isConnecting}
                            onBlur={(event) =>
                              void handleWriteAppSettings({
                                codexBackend: {
                                  sessionMonitor: {
                                    chromeRoot: event.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </SettingsRow>
                      </div>
                    ) : null}
                    {/* Global cleanup controls were replaced by the per-account switch. */}
                    {/*
                    <SettingsRow
                      title={
                        locale === "fa"
                          ? "گزارش و پاک‌سازی نشست‌های Codex در Chrome"
                          : "Chrome Codex session reporting and cleanup"
                      }
                      description={
                        locale === "fa"
                          ? "تعداد نشست‌های Codex و سابقهٔ خروج همیشه گزارش می‌شوند. این کلید فقط اجازه می‌دهد نشست‌های اضافه خودکار خارج شوند؛ نشست دستگاه فعلی همیشه محفوظ است."
                          : "Codex session counts and revoke history are always reported. This switch only allows automatic cleanup of extra sessions; the current device is always protected."
                      }
                    >
                      <fieldset
                        className="grid w-full max-w-2xl gap-3 sm:grid-cols-3"
                        disabled={codexManagerPending || isConnecting}
                      >
                        <button
                          type="button"
                          role="switch"
                          aria-checked={Boolean(codexSessionMonitor?.enabled && !codexSessionMonitor?.dryRun)}
                          disabled={codexManagerPending || isConnecting}
                          onClick={() => {
                            const enabled = !(codexSessionMonitor?.enabled && !codexSessionMonitor?.dryRun);
                            void handleWriteAppSettings({
                              codexBackend: { sessionMonitor: { enabled, dryRun: !enabled } },
                            });
                          }}
                          className={cn(
                            "flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 text-xs font-medium transition-colors",
                            codexSessionMonitor?.enabled && !codexSessionMonitor?.dryRun
                              ? "border-emerald-500/35 bg-emerald-500/10 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-muted/50",
                          )}
                        >
                          <span>{locale === "fa" ? "خروج خودکار نشست‌های اضافه" : "Automatically revoke extra sessions"}</span>
                          <span className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", codexSessionMonitor?.enabled && !codexSessionMonitor?.dryRun ? "bg-emerald-500" : "bg-muted-foreground/30")}>
                            <span className={cn("absolute size-4 rounded-full bg-background shadow-sm transition-transform", codexSessionMonitor?.enabled && !codexSessionMonitor?.dryRun ? "translate-x-4 rtl:-translate-x-4" : "translate-x-0.5 rtl:-translate-x-0.5")} />
                          </span>
                        </button>
                        <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
                          <span>
                            {locale === "fa" ? "هر چند وقت نشست‌های اضافه بررسی شوند؟" : "Audit interval"}
                          </span>
                          <Select
                            value={String(
                              codexSessionMonitor?.intervalSeconds ?? 300,
                            )}
                            onValueChange={(value) =>
                              void handleWriteAppSettings({
                                codexBackend: {
                                  sessionMonitor: {
                                    intervalSeconds: Number(value),
                                  },
                                },
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent dir={direction}>
                              <SelectItem value="300">
                                {locale === "fa" ? "هر ۵ دقیقه" : "Every 5 minutes"}
                              </SelectItem>
                              <SelectItem value="900">
                                {locale === "fa" ? "هر ۱۵ دقیقه" : "Every 15 minutes"}
                              </SelectItem>
                              <SelectItem value="1800">
                                {locale === "fa" ? "هر ۳۰ دقیقه" : "Every 30 minutes"}
                              </SelectItem>
                              <SelectItem value="3600">
                                {locale === "fa" ? "هر ۱ ساعت" : "Every hour"}
                              </SelectItem>
                              <SelectItem value="21600">
                                {locale === "fa"
                                  ? "هر ۶ ساعت"
                                  : "Every 6 hours"}
                              </SelectItem>
                              <SelectItem value="43200">
                                {locale === "fa"
                                  ? "هر ۱۲ ساعت"
                                  : "Every 12 hours"}
                              </SelectItem>
                              <SelectItem value="86400">
                                {locale === "fa" ? "هر روز" : "Daily"}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <span className="text-[11px] font-normal leading-relaxed text-muted-foreground">
                            {locale === "fa"
                              ? "هر بررسی تعداد loginهای Codex را می‌بیند. بازهٔ کوتاه‌تر سریع‌تر نشست اضافه را پیدا می‌کند، اما Chrome و ChatGPT را بیشتر بررسی می‌کند."
                              : "Each run counts Codex logins. Shorter intervals find extra sessions sooner but check Chrome and ChatGPT more often."}
                          </span>
                        </label>
                        <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground sm:col-span-3">
                          <span>
                            {locale === "fa"
                              ? "مسیر دادهٔ Chrome (اختیاری)"
                              : "Chrome data directory (optional)"}
                          </span>
                          <Input
                            key={codexSessionMonitor?.chromeRoot ?? ""}
                            defaultValue={codexSessionMonitor?.chromeRoot ?? ""}
                            dir="ltr"
                            className="h-9 font-mono text-left text-xs"
                            placeholder={
                              locale === "fa"
                                ? "پیش‌فرض سیستم"
                                : "Use the system default"
                            }
                            onBlur={(event) =>
                              void handleWriteAppSettings({
                                codexBackend: {
                                  sessionMonitor: {
                                    chromeRoot: event.target.value,
                                  },
                                },
                              })
                            }
                          />
                          <span className="text-[11px] font-normal text-muted-foreground">
                            {locale === "fa"
                              ? "فقط مسیر مطلق پذیرفته می‌شود؛ پس از تغییر، بررسی پروفایل و پایش بعدی از همین مسیر استفاده می‌کنند."
                              : "Only an absolute path is accepted; profile discovery and the next audit use this directory."}
                          </span>
                        </label>
                        <p
                          className="sm:col-span-3 text-xs text-muted-foreground"
                          aria-live="polite"
                        >
                          {(() => {
                            const monitor =
                              codexManagerGateway?.diagnostics?.sessionMonitor;
                            if (!monitor) {
                              return locale === "fa"
                                ? "گزارش نشست‌ها در حال آماده‌سازی است."
                                : "Session reporting is initializing.";
                            }
                            if (monitor?.lastError) return monitor?.lastError;
                            if (monitor?.lastRun) {
                              const action = monitor?.enabled && !monitor?.dryRun
                                ? locale === "fa"
                                  ? "پاک‌سازی انجام شد"
                                  : "Cleanup completed"
                                : locale === "fa"
                                  ? "گزارش نشست‌ها به‌روز شد"
                                  : "Session report updated";
                              return `${action}: ${monitor?.profilesChecked ?? 0} ${locale === "fa" ? "پروفایل،" : "profiles,"} ${monitor?.targets ?? 0} ${locale === "fa" ? "نشست اضافه" : "extra sessions"}${monitor?.dryRun ? "" : `, ${monitor?.revoked ?? 0} ${locale === "fa" ? "خارج شد" : "revoked"}`}.`;
                            }
                            return locale === "fa"
                              ? "گزارش نشست‌ها در زمان‌بندی بعدی انجام می‌شود؛ خروج خودکار فعلاً خاموش است."
                              : "Session reporting will run on its next schedule; automatic cleanup is currently off.";
                          })()}
                        </p>
                      </fieldset>
                    </SettingsRow>
                    */}
                    {codexManagerTab === "chrome" ? (
                      <div
                        id="codex-manager-panel-chrome"
                        role="tabpanel"
                        aria-labelledby="codex-manager-tab-chrome"
                      >
                        <BrowserSessionsPanel
                          locale={locale}
                          refreshKey={codexManagerRefreshKey}
                        />
                      </div>
                    ) : null}
                    {codexManagerTab === "charts" ? (
                      <div
                        id="codex-manager-panel-charts"
                        role="tabpanel"
                        aria-labelledby="codex-manager-tab-charts"
                      >
                        <UsageHistoryChart locale={locale} />
                      </div>
                    ) : null}
                  </div>
                ) : selectedPage === "providers" ? (
                  <div className="border-b border-border">
                    <SettingsRow
                      title={
                        locale === "fa" ? "Provider سفارشی" : "Custom provider"
                      }
                      description={
                        locale === "fa"
                          ? "برای endpoint سازگار با Responses API. mapping مدل فقط در این حالت در دسترس است."
                          : "For a Responses API-compatible endpoint. Model mapping is available only in this mode."
                      }
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          customProviderEditorOpen ? "secondary" : "outline"
                        }
                        onClick={() =>
                          setCustomProviderEditorOpen((open) => !open)
                        }
                        disabled={codexManagerPending || isConnecting}
                        aria-expanded={customProviderEditorOpen}
                      >
                        {customProviderEditorOpen
                          ? locale === "fa"
                            ? "بستن تنظیمات سفارشی"
                            : "Close custom settings"
                          : locale === "fa"
                            ? "تنظیم Provider سفارشی"
                            : "Configure custom provider"}
                      </Button>
                    </SettingsRow>
                    {customProviderEditorOpen && appSettings ? (
                      <div className="px-4 pb-4">
                        <CustomProviderEditor
                          locale={locale}
                          providers={appSettings.codexBackend.customProviders}
                          activeProviderID={
                            appSettings.codexBackend.customProviderId
                          }
                          onActivate={activateCustomProvider}
                          onRefresh={state.handleReadAppSettings}
                        />
                      </div>
                    ) : null}

                    <SettingsRow
                      title={dictionary.settings.defaultProvider}
                      description={
                        dictionary.settings.defaultProviderDescription
                      }
                      bordered={false}
                    >
                      <Select
                        value={defaultProvider}
                        onValueChange={(value) =>
                          handleDefaultProviderChange(
                            value as "last_used" | AgentProvider,
                          )
                        }
                      >
                        <SelectTrigger className="min-w-[180px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="last_used">
                              {dictionary.settings.lastUsed}
                            </SelectItem>
                            {PROVIDERS.map((provider) => (
                              <SelectItem key={provider.id} value={provider.id}>
                                {provider.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </SettingsRow>

                    <SettingsRow
                      title={
                        locale === "fa"
                          ? "پیام هنگام اجرای turn"
                          : "Message during an active turn"
                      }
                      description={
                        locale === "fa"
                          ? "صف، ترتیب پیام‌ها را حفظ می‌کند. Steer تلاش می‌کند پیام تازه را فوراً به turn فعال تحویل دهد؛ اگر ممکن نباشد در صف می‌ماند. صف پس از خطا ادامه پیدا می‌کند."
                          : "Queue preserves message order. Steer tries to deliver the new message to the active turn immediately; if unavailable, it remains queued. Queued messages continue after errors."
                      }
                    >
                      <Select
                        value={appSettings?.queueDeliveryMode ?? "queue"}
                        onValueChange={(value) =>
                          handleQueueDeliveryModeChange(
                            value as "queue" | "steer",
                          )
                        }
                      >
                        <SelectTrigger className="min-w-[180px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="queue">
                            {locale === "fa" ? "همیشه صف" : "Always queue"}
                          </SelectItem>
                          <SelectItem value="steer">
                            {locale === "fa"
                              ? "Steer فوری"
                              : "Steer immediately"}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingsRow>

                    <SettingsRow
                      title={dictionary.settings.commitMessageAi}
                      description={
                        <>
                          <span>
                            {dictionary.settings.commitMessageAiDescription}
                          </span>
                          <span className="mt-1 block">
                            {
                              dictionary.settings
                                .commitMessageAiTemporarySession
                            }
                          </span>
                        </>
                      }
                      alignStart
                    >
                      <div className="grid w-full max-w-[420px] gap-3 sm:grid-cols-2">
                        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                          <span>
                            {dictionary.settings.commitMessageAiAgent}
                          </span>
                          <Select
                            value={commitMessageGenerator.provider}
                            onValueChange={(value) =>
                              handleCommitMessageProviderChange(
                                value as AgentProvider,
                              )
                            }
                          >
                            <SelectTrigger className="min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {settingsAvailableProviders.map((provider) => (
                                  <SelectItem
                                    key={provider.id}
                                    value={provider.id}
                                  >
                                    {provider.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                          <span>
                            {dictionary.settings.commitMessageAiModel}
                          </span>
                          <Select
                            value={commitMessageGenerator.model}
                            onValueChange={handleCommitMessageModelChange}
                          >
                            <SelectTrigger className="min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {commitMessageModelOptions.map((model) => (
                                  <SelectItem key={model.id} value={model.id}>
                                    {model.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </label>
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title={dictionary.settings.modelCatalog}
                      description={
                        <>
                          <span>
                            {dictionary.settings.modelCatalogDescription}
                          </span>
                          <span className="mt-1 block">
                            {modelCatalogLastRefresh}
                          </span>
                          {modelCatalogErrorCount > 0 ? (
                            <span className="mt-1 block text-destructive">
                              {dictionary.settings.modelCatalogErrors(
                                modelCatalogErrorCount,
                              )}
                            </span>
                          ) : null}
                        </>
                      }
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleRefreshProviderModels()}
                        disabled={modelRefreshStatus === "loading"}
                        className="gap-1.5"
                      >
                        {modelRefreshStatus === "loading" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        {modelRefreshStatus === "loading"
                          ? dictionary.settings.refreshingModels
                          : dictionary.settings.refreshModels}
                      </Button>
                    </SettingsRow>

                    <SettingsRow
                      title={dictionary.settings.claudeDefaults}
                      description={
                        dictionary.settings.claudeDefaultsDescription
                      }
                      alignStart
                    >
                      <div className="max-w-[420px]">
                        <ChatPreferenceControls
                          availableProviders={settingsAvailableProviders}
                          selectedProvider="claude"
                          showProviderPicker={false}
                          providerLocked
                          model={providerDefaults.claude.model}
                          modelMode={providerDefaults.claude.modelMode}
                          reasoningEffortMode={
                            providerDefaults.claude.reasoningEffortMode
                          }
                          modelOptions={providerDefaults.claude.modelOptions}
                          onModelChange={(_, model) => {
                            handleProviderDefaultModelChange("claude", model);
                          }}
                          onModelModeChange={(modelMode) =>
                            handleProviderDefaultModelModeChange(
                              "claude",
                              modelMode,
                            )
                          }
                          onReasoningEffortModeChange={(reasoningEffortMode) =>
                            handleProviderDefaultReasoningEffortModeChange(
                              "claude",
                              reasoningEffortMode,
                            )
                          }
                          onModelOptionChange={(change) => {
                            if (change.type === "claudeReasoningEffort") {
                              handleProviderDefaultModelOptionsChange(
                                "claude",
                                { reasoningEffort: change.effort },
                              );
                            } else if (change.type === "contextWindow") {
                              handleProviderDefaultModelOptionsChange(
                                "claude",
                                { contextWindow: change.contextWindow },
                              );
                            }
                          }}
                          planMode={providerDefaults.claude.planMode}
                          onPlanModeChange={(planMode) =>
                            handleProviderDefaultPlanModeChange(
                              "claude",
                              planMode,
                            )
                          }
                          includePlanMode
                          className="justify-start flex-wrap"
                        />
                        <Input
                          value={providerExecutableDrafts.claude ?? ""}
                          onChange={(event) =>
                            handleProviderExecutableDraftChange(
                              "claude",
                              event.target.value,
                            )
                          }
                          onBlur={() => commitProviderExecutable("claude")}
                          onKeyDown={(event) =>
                            handleTextInputKeyDown(event, () =>
                              commitProviderExecutable("claude"),
                            )
                          }
                          placeholder={dictionary.settings.providerExecutablePlaceholder(
                            "claude",
                          )}
                          aria-label={dictionary.settings.providerExecutable(
                            "Claude",
                          )}
                          className="mt-3 w-full font-mono text-xs"
                          dir="ltr"
                        />
                        {renderModelCatalogControls("claude")}
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title={dictionary.settings.codexDefaults}
                      description={dictionary.settings.codexDefaultsDescription}
                      alignStart
                    >
                      <div className="max-w-[420px]">
                        <ChatPreferenceControls
                          availableProviders={settingsAvailableProviders}
                          selectedProvider="codex"
                          showProviderPicker={false}
                          providerLocked
                          model={providerDefaults.codex.model}
                          modelMode={providerDefaults.codex.modelMode}
                          reasoningEffortMode={
                            providerDefaults.codex.reasoningEffortMode
                          }
                          modelOptions={providerDefaults.codex.modelOptions}
                          onModelChange={(_, model) => {
                            handleProviderDefaultModelChange("codex", model);
                          }}
                          onModelModeChange={(modelMode) =>
                            handleProviderDefaultModelModeChange(
                              "codex",
                              modelMode,
                            )
                          }
                          onReasoningEffortModeChange={(reasoningEffortMode) =>
                            handleProviderDefaultReasoningEffortModeChange(
                              "codex",
                              reasoningEffortMode,
                            )
                          }
                          onModelOptionChange={(change) => {
                            if (change.type === "codexReasoningEffort") {
                              handleProviderDefaultModelOptionsChange("codex", {
                                reasoningEffort: change.effort,
                              });
                            } else if (change.type === "fastMode") {
                              handleProviderDefaultModelOptionsChange("codex", {
                                fastMode: change.fastMode,
                              });
                            } else if (change.type === "executionMode") {
                              handleProviderDefaultModelOptionsChange("codex", {
                                executionMode: change.executionMode,
                              });
                            }
                          }}
                          planMode={providerDefaults.codex.planMode}
                          onPlanModeChange={(planMode) =>
                            handleProviderDefaultPlanModeChange(
                              "codex",
                              planMode,
                            )
                          }
                          includePlanMode
                          className="justify-start flex-wrap"
                        />
                        <Input
                          value={providerExecutableDrafts.codex ?? ""}
                          onChange={(event) =>
                            handleProviderExecutableDraftChange(
                              "codex",
                              event.target.value,
                            )
                          }
                          onBlur={() => commitProviderExecutable("codex")}
                          onKeyDown={(event) =>
                            handleTextInputKeyDown(event, () =>
                              commitProviderExecutable("codex"),
                            )
                          }
                          placeholder={dictionary.settings.providerExecutablePlaceholder(
                            "codex",
                          )}
                          aria-label={dictionary.settings.providerExecutable(
                            "Codex",
                          )}
                          className="mt-3 w-full font-mono text-xs"
                          dir="ltr"
                        />
                        {renderModelCatalogControls("codex")}
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title="OpenCode"
                      description={
                        locale === "fa"
                          ? "مدل پیش‌فرض و مسیر برنامهٔ OpenCode. نشست‌ها مستقیماً از OpenCode خوانده می‌شوند."
                          : "Default model and OpenCode executable path. Sessions are read directly from OpenCode."
                      }
                      alignStart
                    >
                      <div className="max-w-[420px]">
                        <ChatPreferenceControls
                          availableProviders={settingsAvailableProviders}
                          selectedProvider="opencode"
                          showProviderPicker={false}
                          providerLocked
                          model={providerDefaults.opencode.model}
                          modelMode={providerDefaults.opencode.modelMode}
                          modelOptions={providerDefaults.opencode.modelOptions}
                          onModelChange={(_, model) =>
                            handleProviderDefaultModelChange("opencode", model)
                          }
                          onModelModeChange={(modelMode) =>
                            handleProviderDefaultModelModeChange(
                              "opencode",
                              modelMode,
                            )
                          }
                          onModelOptionChange={() => undefined}
                          includePlanMode={false}
                          className="justify-start flex-wrap"
                        />
                        <Input
                          value={providerExecutableDrafts.opencode ?? ""}
                          onChange={(event) =>
                            handleProviderExecutableDraftChange(
                              "opencode",
                              event.target.value,
                            )
                          }
                          onBlur={() => commitProviderExecutable("opencode")}
                          onKeyDown={(event) =>
                            handleTextInputKeyDown(event, () =>
                              commitProviderExecutable("opencode"),
                            )
                          }
                          placeholder={dictionary.settings.providerExecutablePlaceholder(
                            "opencode",
                          )}
                          aria-label={dictionary.settings.providerExecutable(
                            "OpenCode",
                          )}
                          className="mt-3 w-full font-mono text-xs"
                          dir="ltr"
                        />
                        {renderModelCatalogControls("opencode")}
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title={dictionary.settings.quickResponseSdk}
                      description={llmValidationDescription}
                      alignStart
                    >
                      <div className="flex w-full max-w-[420px] flex-col gap-3">
                        {llmProviderError ? (
                          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                            {llmProviderError}
                          </div>
                        ) : null}
                        {llmProvider?.warning ? (
                          <div className="rounded-lg border border-border bg-card/30 px-4 py-3 text-sm text-muted-foreground">
                            {llmProvider.warning}
                          </div>
                        ) : null}
                        <Select
                          value={llmProviderDraft.provider}
                          onValueChange={(value) =>
                            handleLlmProviderSelection(value as LlmProviderKind)
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {QUICK_RESPONSE_PROVIDER_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {llmProviderDraft.provider === "custom" ? (
                          <Input
                            value={llmProviderDraft.baseUrl}
                            onChange={(event) =>
                              setLlmProviderDraft((current) => ({
                                ...current,
                                baseUrl: event.target.value,
                              }))
                            }
                            onBlur={() => void commitLlmProvider()}
                            onKeyDown={(event) =>
                              handleTextInputKeyDown(
                                event,
                                () => void commitLlmProvider(),
                              )
                            }
                            placeholder="https://your-provider.example/v1"
                          />
                        ) : null}
                        <Input
                          type="password"
                          value={llmProviderDraft.apiKey}
                          onChange={(event) =>
                            setLlmProviderDraft((current) => ({
                              ...current,
                              apiKey: event.target.value,
                            }))
                          }
                          onBlur={() => void commitLlmProvider()}
                          onKeyDown={(event) =>
                            handleTextInputKeyDown(
                              event,
                              () => void commitLlmProvider(),
                            )
                          }
                          placeholder="API key"
                        />
                        <Input
                          value={llmProviderDraft.model}
                          onChange={(event) =>
                            setLlmProviderDraft((current) => ({
                              ...current,
                              model: event.target.value,
                            }))
                          }
                          onBlur={() => void commitLlmProvider()}
                          onKeyDown={(event) =>
                            handleTextInputKeyDown(
                              event,
                              () => void commitLlmProvider(),
                            )
                          }
                          placeholder="Model id"
                        />
                      </div>
                    </SettingsRow>
                  </div>
                ) : selectedPage === "proxy" ? (
                  <div className="border-b border-border">
                    {appSettingsError ? (
                      <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {appSettingsError}
                      </div>
                    ) : null}
                    <SettingsRow
                      title={dictionary.settings.providerProxy}
                      description={dictionary.settings.providerProxyDescription}
                      bordered={false}
                    >
                      <SegmentedControl
                        value={providerProxy.mode}
                        onValueChange={(value) =>
                          handleProviderProxyModeChange(
                            value as ProviderProxyMode,
                          )
                        }
                        options={localizedProviderProxyOptions}
                        size="sm"
                      />
                    </SettingsRow>

                    <SettingsRow
                      title={dictionary.settings.providerProxyHttp}
                      description={
                        dictionary.settings.providerProxyHttpDescription
                      }
                    >
                      <Input
                        type="text"
                        value={providerProxyHttpDraft}
                        onChange={(event) =>
                          setProviderProxyHttpDraft(event.target.value)
                        }
                        onBlur={commitProviderProxySettings}
                        onKeyDown={(event) =>
                          handleTextInputKeyDown(
                            event,
                            commitProviderProxySettings,
                          )
                        }
                        disabled={providerProxy.mode !== "custom"}
                        placeholder="http://127.0.0.1:7890"
                        className="w-full min-w-[240px] font-mono md:w-[320px]"
                      />
                    </SettingsRow>

                    <SettingsRow
                      title={dictionary.settings.providerProxyNoProxy}
                      description={
                        dictionary.settings.providerProxyNoProxyDescription
                      }
                    >
                      <Input
                        type="text"
                        value={providerProxyNoProxyDraft}
                        onChange={(event) =>
                          setProviderProxyNoProxyDraft(event.target.value)
                        }
                        onBlur={commitProviderProxySettings}
                        onKeyDown={(event) =>
                          handleTextInputKeyDown(
                            event,
                            commitProviderProxySettings,
                          )
                        }
                        disabled={providerProxy.mode !== "custom"}
                        placeholder="localhost,127.0.0.1,::1"
                        className="w-full min-w-[240px] font-mono md:w-[320px]"
                      />
                    </SettingsRow>
                  </div>
                ) : selectedPage === "keybindings" ? (
                  <div className="border-b border-border">
                    {keybindingsError ? (
                      <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {keybindingsError}
                      </div>
                    ) : null}
                    {resolvedKeybindings.warning ? (
                      <div className="mb-4 rounded-lg border border-border bg-card/30 px-4 py-3 text-sm text-muted-foreground">
                        {resolvedKeybindings.warning}
                      </div>
                    ) : null}
                    {KEYBINDING_ACTIONS.map((action, index) => {
                      const defaultValue = formatKeybindingInput(
                        DEFAULT_KEYBINDINGS[action],
                      );
                      const currentValue = keybindingDrafts[action] ?? "";
                      const showRestore = currentValue !== defaultValue;

                      return (
                        <SettingsRow
                          key={action}
                          title={KEYBINDING_ACTION_LABELS[action]}

                          description={
                            <>
                              <span>
                                {dictionary.settings.commaSeparatedShortcuts}
                              </span>
                              {showRestore ? (
                                <>
                                  <span> </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void restoreDefaultKeybinding(action);
                                    }}
                                    className="inline rounded text-foreground hover:text-foreground/80"
                                  >
                                    {dictionary.settings.restore(defaultValue)}
                                  </button>
                                </>
                              ) : null}
                            </>
                          }
                          bordered={index !== 0}
                        >
                          <div className="flex min-w-0 max-w-[420px] flex-1 flex-col items-stretch gap-2">
                            <Input
                              type="text"
                              value={currentValue}
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setKeybindingDrafts((current) => ({
                                  ...current,
                                  [action]: nextValue,
                                }));
                              }}
                              onBlur={() => {
                                void commitKeybindings();
                              }}
                              onKeyDown={(event) =>
                                handleTextInputKeyDown(event, () => {
                                  void commitKeybindings();
                                })
                              }
                              className="font-mono"
                            />
                          </div>
                        </SettingsRow>
                      );
                    })}
                  </div>
                ) : selectedPage === "usage" ? (
                  <UsageSettingsSection locale={locale} />
                ) : selectedPage === "skills" ? (
                  <SkillsSection state={state} />
                ) : selectedPage === "mcp" ? (
                  <McpSection state={state} />
                ) : (
                  <ChangelogSection
                    status={changelogStatus}
                    releases={releases}
                    error={changelogError}
                    onRetry={retryChangelog}
                    updateSnapshot={updateSnapshot}
                    currentVersion={appVersion}
                    onInstallUpdate={() => state.handleInstallUpdate()}
                    onCheckForUpdates={() =>
                      state.handleCheckForUpdates({ force: true })
                    }
                  />
                )}
              </div>
            )}

            {state.commandError ? (
              <div className="mx-auto mt-4 flex max-w-4xl items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{state.commandError}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {showFooter ? (
        <div className="absolute bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="px-6 py-[14.25px]">
            <div className="grid gap-3 text-xs text-muted-foreground grid-cols-2 lg:grid-cols-4">
              <div>
                <div className={footerLabelClassName}>
                  {dictionary.settings.machine}
                </div>
                <div className="text-foreground/80">{machineName}</div>
              </div>
              <div className="hidden md:block">
                <div className={footerLabelClassName}>
                  {dictionary.settings.connection}
                </div>
                <div className="text-foreground/80">
                  {localizedConnectionStatus}
                </div>
              </div>
              <div className="hidden md:block">
                <div className={footerLabelClassName}>
                  {dictionary.settings.projectsIndexed}
                </div>
                <div className="text-foreground/80">{projectCount}</div>
              </div>
              <div>
                <div className={footerLabelClassName}>
                  {dictionary.settings.appVersion}
                </div>
                <div className="text-foreground/80">{appVersion}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <Dialog
        open={llmValidationDialogOpen}
        onOpenChange={setLlmValidationDialogOpen}
      >
        <DialogContent size="lg">
          <DialogBody className="space-y-4">
            <DialogTitle>{dictionary.settings.validationError}</DialogTitle>
            <DialogDescription className="sr-only">
              {dictionary.settings.validationError}
            </DialogDescription>
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words">
              {llmValidationErrorText}
            </pre>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLlmValidationDialogOpen(false)}
            >
              {dictionary.common.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeviceLoginDialog
        locale={locale}
        open={deviceLoginOpen}
        onOpenChange={setDeviceLoginOpen}
        onCompleted={handleCodexManagerLoginCompleted}
        initialAccountName={deviceLoginAccountName}
        replaceExisting={Boolean(deviceLoginAccountName)}
      />
    </div>
  );
}

function buildKeybindingPayload(
  source: Record<string, string>,
): Record<KeybindingAction, string[]> {
  return {
    toggleEmbeddedTerminal: parseKeybindingInput(
      source.toggleEmbeddedTerminal ?? "",
    ),
    toggleRightSidebar: parseKeybindingInput(source.toggleRightSidebar ?? ""),
    openInFinder: parseKeybindingInput(source.openInFinder ?? ""),
    openInEditor: parseKeybindingInput(source.openInEditor ?? ""),
    addSplitTerminal: parseKeybindingInput(source.addSplitTerminal ?? ""),
    jumpToSidebarChat: parseKeybindingInput(source.jumpToSidebarChat ?? ""),
    createChatInCurrentProject: parseKeybindingInput(
      source.createChatInCurrentProject ?? "",
    ),
    openAddProject: parseKeybindingInput(source.openAddProject ?? ""),
  };
}
