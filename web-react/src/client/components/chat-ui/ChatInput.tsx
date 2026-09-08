import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  LoaderCircle,
  LockKeyhole,
  LockKeyholeOpen,
  Paperclip,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import {
  type AgentProvider,
  type ChatAttachment,
  type ClaudeContextWindow,
  type ClaudeReasoningEffort,
  type CodexExecutionMode,
  type CodexLockStatus,
  type CodexReasoningEffort,
  type ModelOptions,
  type ProviderCatalogEntry,
  type RateLimitSnapshot,
  DEFAULT_OPENCODE_MODEL_OPTIONS,
  normalizeClaudeContextWindow,
  resolveClaudeContextWindowTokens,
} from "../../../shared/types";
import { Button, buttonVariants } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { useIsStandalone } from "../../hooks/useIsStandalone";
import { useChatInputStore } from "../../stores/chatInputStore";
import {
  NEW_CHAT_COMPOSER_ID,
  type ComposerState,
  useChatPreferencesStore,
} from "../../stores/chatPreferencesStore";
import {
  CHAT_INPUT_ATTRIBUTE,
  focusNextChatInput,
} from "../../app/chatFocusPolicy";
import { ChatPreferenceControls } from "./ChatPreferenceControls";
import { SessionHealthPopover } from "./SessionHealthPopover";
import { AgentActivityIndicator } from "./AgentActivityIndicator";
import {
  AttachmentFileCard,
  AttachmentImageCard,
} from "../messages/AttachmentCard";
import { AttachmentPreviewModal } from "../messages/AttachmentPreviewModal";
import { classifyAttachmentPreview } from "../messages/attachmentPreview";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  overrideContextWindowMaxTokens,
  type ContextWindowSnapshot,
} from "../../lib/contextWindow";
import { useI18n } from "../../i18n/context";

const MAX_FILES_PER_DROP = 50;
const MAX_CONCURRENT_UPLOADS = 3;
export const PASTED_TEXT_FILE_THRESHOLD = 2000;

const CLIPBOARD_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function willExceedAttachmentLimit(args: {
  currentAttachmentCount: number;
  queuedAttachmentCount: number;
  incomingAttachmentCount: number;
  maxAttachments?: number;
}) {
  const maxAttachments = args.maxAttachments ?? MAX_FILES_PER_DROP;
  return (
    args.currentAttachmentCount +
      args.queuedAttachmentCount +
      args.incomingAttachmentCount >
    maxAttachments
  );
}

type ClipboardFileItem = Pick<DataTransferItem, "kind" | "type" | "getAsFile">;

function hasClipboardTextPayload(
  clipboardData: DataTransfer | null | undefined,
) {
  if (!clipboardData) return false;
  return (
    clipboardData.types.includes("text/plain") ||
    clipboardData.types.includes("text/html")
  );
}

function getClipboardImageExtension(file: File) {
  return CLIPBOARD_EXTENSION_BY_MIME_TYPE[file.type] ?? "bin";
}

function isGenericClipboardImageName(file: File) {
  const normalized = file.name.trim().toLowerCase();
  if (!normalized) return true;

  const expectedExtension = getClipboardImageExtension(file);
  return (
    normalized === `image.${expectedExtension}` || normalized === "image.png"
  );
}

function normalizeClipboardImageFile(
  file: File,
  index: number,
  timestamp: number,
) {
  if (file.name && !isGenericClipboardImageName(file)) return file;

  const extension = getClipboardImageExtension(file);
  const suffix = index === 0 ? "" : `-${index}`;
  const fileName = `clipboard-${timestamp}${suffix}.${extension}`;
  Object.defineProperty(file, "name", {
    configurable: true,
    value: fileName,
  });
  return file;
}

export function getClipboardImageFiles(
  items: Iterable<ClipboardFileItem>,
  timestamp: number,
) {
  const files: File[] = [];

  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    files.push(normalizeClipboardImageFile(file, files.length, timestamp));
  }

  return files;
}

export function trimTrailingPastedNewlines(text: string) {
  return text.replace(/(?:\r\n|\r|\n)+$/, "");
}

export function createPastedTextFile(text: string, now = new Date()) {
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("-");
  return new File([text], `pasted-text-${timestamp}.txt`, {
    type: "text/plain",
    lastModified: now.getTime(),
  });
}

export function shouldApplyCodexExecutionModeToRuntime(
  providerLocked: boolean,
  provider: AgentProvider,
  lockState: CodexLockStatus["state"] | undefined,
) {
  return providerLocked && provider === "codex" && lockState === "owned_by_us";
}

function replaceTextSelection(args: {
  value: string;
  insertedText: string;
  selectionStart: number;
  selectionEnd: number;
}) {
  return `${args.value.slice(0, args.selectionStart)}${args.insertedText}${args.value.slice(args.selectionEnd)}`;
}

interface ComposerAttachment extends ChatAttachment {
  status: "uploading" | "uploaded" | "failed";
  previewUrl?: string;
}

interface Props {
  onSubmit: (
    value: string,
    options?: {
      provider?: AgentProvider;
      model?: string;
      modelOptions?: ModelOptions;
      planMode?: boolean;
      attachments?: ChatAttachment[];
    },
  ) => Promise<void>;
  onRuntimePreferenceChange?: (preference: {
    provider: AgentProvider;
    model: string;
    modelOptions: ModelOptions;
  }) => Promise<void>;
  runtimePlanMode?: boolean;
  onRuntimePlanModeChange?: (planMode: boolean) => Promise<void>;
  onLayoutChange?: () => void;
  onCancel?: () => void;
  disabled: boolean;
  connectionStatus?: "connecting" | "connected" | "disconnected";
  runtimeStatus?: string | null;
  processingStatus?: string | null;
  turnStartedAt?: number | null;
  canCancel?: boolean;
  chatId?: string | null;
  projectId?: string | null;
  inputElementRef?: React.Ref<HTMLTextAreaElement>;
  activeProvider: AgentProvider | null;
  availableProviders: ProviderCatalogEntry[];
  showPreferenceControls?: boolean;
  contextWindowSnapshot?: ContextWindowSnapshot | null;
  rateLimitSnapshot?: RateLimitSnapshot | null;
  accountEmail?: string | null;
  onAccountActivated?: () => void | Promise<void>;
  readOnly?: boolean;
  codexLock?: CodexLockStatus | null;
  lockBusy?: boolean;
  onTakeOverSession?: (executionMode: CodexExecutionMode) => void;
  onReleaseSession?: () => void;
  onRefreshSessionLock?: () => void;
  onCodexExecutionModeChange?: (executionMode: CodexExecutionMode) => void;
  onReloadCodexAuth?: () => void;
  previousPrompt?: string | null;
  onJumpToPreviousUserPrompt?: () => void | Promise<void>;
}

export interface ChatInputHandle {
  enqueueFiles: (files: File[]) => void;
  insertText: (text: string) => void;
  appendText: (text: string) => void;
  hasUnsavedDraft: () => boolean;
  hydrateDraft: (text: string, attachments: ChatAttachment[]) => void;
}

function withNormalizedContextWindow(
  state: ComposerState,
  model: string,
): ComposerState {
  if (state.provider !== "claude") return { ...state, model };
  return {
    ...state,
    model,
    modelOptions: {
      ...state.modelOptions,
      contextWindow: normalizeClaudeContextWindow(
        model,
        state.modelOptions.contextWindow,
      ),
    },
  };
}

function getEffectiveComposerState(
  composerState: ComposerState,
  activeProvider: AgentProvider | null,
  providerDefaults: ReturnType<
    typeof useChatPreferencesStore.getState
  >["providerDefaults"],
): ComposerState {
  if (!activeProvider || composerState.provider === activeProvider) {
    return composerState;
  }

  if (activeProvider === "claude") {
    return {
      provider: "claude",
      model: providerDefaults.claude.model,
      modelOptions: { ...providerDefaults.claude.modelOptions },
      planMode: composerState.planMode,
    };
  }

  if (activeProvider === "opencode") {
    return {
      provider: "opencode",
      model: providerDefaults.opencode.model,
      modelOptions: { ...providerDefaults.opencode.modelOptions },
      planMode: composerState.planMode,
    };
  }

  return {
    provider: "codex",
    model: providerDefaults.codex.model,
    modelOptions: { ...providerDefaults.codex.modelOptions },
    planMode: composerState.planMode,
  };
}

const ChatInputInner = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    onSubmit,
    onRuntimePreferenceChange,
    runtimePlanMode,
    onRuntimePlanModeChange,
    onLayoutChange,
    onCancel,
    disabled,
    connectionStatus = "connected",
    runtimeStatus = null,
    processingStatus = null,
    turnStartedAt = null,
    canCancel,
    chatId,
    projectId,
    inputElementRef,
    activeProvider,
    availableProviders,
    showPreferenceControls = true,
    contextWindowSnapshot = null,
    rateLimitSnapshot = null,
    accountEmail = null,
    onAccountActivated,
    readOnly = false,
    codexLock = null,
    lockBusy = false,
    onTakeOverSession,
    onReleaseSession,
    onRefreshSessionLock,
    onCodexExecutionModeChange,
    onReloadCodexAuth,
    previousPrompt = null,
    onJumpToPreviousUserPrompt,
  },
  forwardedRef,
) {
  const { t, direction } = useI18n();
  const isRtl = direction === "rtl";
  const {
    setDraft,
    clearDraft,
    getAttachmentDrafts,
    setAttachmentDrafts,
    clearAttachmentDrafts,
  } = useChatInputStore();
  const {
    providerDefaults,
    getComposerState,
    initializeComposerForChat,
    setComposerState,
    setChatComposerModel,
    setChatComposerPlanMode,
    resetChatComposerFromProvider,
  } = useChatPreferencesStore();
  const composerChatId = chatId ?? NEW_CHAT_COMPOSER_ID;
  const storedComposerState = useChatPreferencesStore(
    (state) => state.chatStates[composerChatId],
  );
  const composerState = storedComposerState ?? getComposerState(composerChatId);
  const persistedDraft = useChatInputStore((state) =>
    chatId ? (state.drafts[chatId] ?? "") : "",
  );
  const [value, setValue] = useState(() => persistedDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStandalone = useIsStandalone();
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() =>
    hydrateComposerAttachments(chatId ? getAttachmentDrafts(chatId) : []),
  );
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<
    string | null
  >(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadQueueRef = useRef<File[]>([]);
  const activeUploadsRef = useRef(0);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const uploadGenerationRef = useRef(0);
  const removedAttachmentIdsRef = useRef<Set<string>>(new Set());
  const previousProjectIdRef = useRef<string | null>(projectId ?? null);
  const latestChatIdRef = useRef<string | null>(chatId ?? null);

  const providerLocked = activeProvider !== null;
  const providerPrefs = getEffectiveComposerState(
    composerState,
    activeProvider,
    providerDefaults,
  );
  const selectedProvider = providerLocked
    ? activeProvider
    : composerState.provider;
  const providerConfig =
    availableProviders.find((provider) => provider.id === selectedProvider) ??
    availableProviders[0];
  const showPlanMode = providerConfig?.supportsPlanMode ?? false;
  const activeContextWindow = useMemo(() => {
    if (providerPrefs.provider !== "claude") {
      return contextWindowSnapshot;
    }

    const claudeModelOptions = providerPrefs.modelOptions as Extract<
      ComposerState,
      { provider: "claude" }
    >["modelOptions"];
    const stagedMaxTokens = resolveClaudeContextWindowTokens(
      normalizeClaudeContextWindow(
        providerPrefs.model,
        claudeModelOptions.contextWindow,
      ),
    );
    return overrideContextWindowMaxTokens(
      contextWindowSnapshot,
      stagedMaxTokens,
    );
  }, [
    contextWindowSnapshot,
    providerPrefs.model,
    providerPrefs.modelOptions,
    providerPrefs.provider,
  ]);
  const uploadedAttachments = attachments.filter(
    (attachment) => attachment.status === "uploaded",
  );
  const hasPendingUploads = attachments.some(
    (attachment) => attachment.status === "uploading",
  );
  const hasTextToSend = value.trim().length > 0;
  const canSubmit = value.trim().length > 0 || uploadedAttachments.length > 0;
  const inputDisabled = disabled || readOnly;
  const connectionUnavailable = connectionStatus !== "connected";
  const submissionDisabled = inputDisabled || connectionUnavailable;
  const isLockedElsewhere = codexLock?.state === "owned_elsewhere";
  const isLockUnknown = codexLock?.state === "unknown";
  const isOwnedByUs = codexLock?.state === "owned_by_us";
  const selectedCodexExecutionMode =
    providerPrefs.provider === "codex"
      ? (providerPrefs.modelOptions.executionMode ?? "dangerous")
      : "dangerous";
  const effectiveCodexExecutionMode =
    isOwnedByUs && codexLock?.executionMode
      ? codexLock.executionMode
      : selectedCodexExecutionMode;
  const lockActionLabel = isLockedElsewhere
    ? t.composer.takeOverSession
    : t.composer.checkSessionLock;
  const effectiveLockActionLabel = lockBusy
    ? t.composer.checkingSessionLock
    : lockActionLabel;
  const refreshSessionTextLabel = isRtl
    ? "رفرش متن نشست"
    : "Refresh session text";
  const lockedPlaceholder = isLockedElsewhere
    ? t.composer.lockedElsewherePlaceholder
    : isLockUnknown
      ? t.composer.sessionLockUnknownPlaceholder
      : connectionStatus === "connecting"
        ? t.composer.reconnectingPlaceholder
        : connectionStatus === "disconnected"
          ? t.composer.connectionLostPlaceholder
          : t.composer.buildSomething;
  const connectionStatusLabel =
    connectionStatus === "connecting"
      ? t.composer.reconnecting
      : t.composer.connectionLost;
  const orderedAttachments = [...attachments].sort((left, right) => {
    if (left.kind === right.kind) return 0;
    return left.kind === "image" ? -1 : 1;
  });
  const selectedAttachment =
    attachments.find((attachment) => attachment.id === selectedAttachmentId) ??
    null;

  useLayoutEffect(() => {
    onLayoutChange?.();
  }, [onLayoutChange, runtimeStatus]);

  const cleanupAttachmentPreview = useCallback(
    (attachment: ComposerAttachment) => {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  const clearAttachments = useCallback(
    (options?: { cleanupPreviews?: boolean }) => {
      const cleanupPreviews = options?.cleanupPreviews ?? true;
      uploadGenerationRef.current += 1;
      removedAttachmentIdsRef.current.clear();
      setAttachments((current) => {
        if (cleanupPreviews) {
          current.forEach(cleanupAttachmentPreview);
        }
        return [];
      });
      uploadQueueRef.current = [];
      activeUploadsRef.current = 0;
      setSelectedAttachmentId(null);
      setUploadError(null);
    },
    [cleanupAttachmentPreview],
  );

  const autoResize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    if (element.value.length === 0) {
      element.style.height = "";
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  const setTextareaRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;

      if (inputElementRef) {
        if (typeof inputElementRef === "function") {
          inputElementRef(node);
        } else {
          inputElementRef.current = node;
        }
      }
    },
    [inputElementRef],
  );

  useLayoutEffect(() => {
    autoResize();
    onLayoutChange?.();
  }, [autoResize, onLayoutChange, value]);

  useEffect(() => {
    const handleResize = () => {
      autoResize();
      onLayoutChange?.();
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [autoResize, onLayoutChange]);

  useLayoutEffect(() => {
    onLayoutChange?.();
  }, [attachments.length, onLayoutChange, uploadError]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [chatId]);

  useEffect(() => {
    latestChatIdRef.current = chatId ?? null;
  }, [chatId]);

  useEffect(() => {
    setValue(persistedDraft);
  }, [persistedDraft]);

  useEffect(() => {
    initializeComposerForChat(composerChatId);
  }, [composerChatId, initializeComposerForChat]);

  useEffect(() => {
    if (!chatId || runtimePlanMode === undefined) return;
    setChatComposerPlanMode(composerChatId, runtimePlanMode);
  }, [chatId, composerChatId, runtimePlanMode, setChatComposerPlanMode]);

  useEffect(() => {
    uploadGenerationRef.current += 1;
    uploadQueueRef.current = [];
    activeUploadsRef.current = 0;
    removedAttachmentIdsRef.current.clear();
    setSelectedAttachmentId(null);
    setUploadError(null);
    setAttachments((current) => {
      current.forEach(cleanupAttachmentPreview);
      return hydrateComposerAttachments(
        chatId ? getAttachmentDrafts(chatId) : [],
      );
    });
  }, [chatId, cleanupAttachmentPreview, getAttachmentDrafts]);

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;
    previousProjectIdRef.current = projectId ?? null;

    if (previousProjectId === null || projectId === previousProjectId) {
      return;
    }

    clearAttachments();
    if (chatId) {
      clearAttachmentDrafts(chatId);
    }
  }, [projectId, chatId, clearAttachments, clearAttachmentDrafts]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (!chatId) return;

    const persistedAttachments = attachments
      .filter((attachment) => attachment.status === "uploaded")
      .map(
        ({ previewUrl: _previewUrl, status: _status, ...attachment }) =>
          attachment,
      );

    if (persistedAttachments.length === 0) {
      clearAttachmentDrafts(chatId);
      return;
    }

    setAttachmentDrafts(chatId, persistedAttachments);
  }, [attachments, chatId, clearAttachmentDrafts, setAttachmentDrafts]);

  useEffect(
    () => () => {
      attachmentsRef.current.forEach(cleanupAttachmentPreview);
    },
    [cleanupAttachmentPreview],
  );

  function updateComposerState(
    transform: (state: ComposerState) => ComposerState,
  ) {
    useChatPreferencesStore
      .getState()
      .setComposerState(composerChatId, transform(providerPrefs));
  }

  function setReasoningEffort(reasoningEffort: string) {
    updateComposerState(
      (state) =>
        ({
          ...state,
          modelOptions: {
            ...state.modelOptions,
            reasoningEffort: reasoningEffort as ClaudeReasoningEffort &
              CodexReasoningEffort,
          },
        }) as ComposerState,
    );
  }

  function setClaudeContextWindow(contextWindow: ClaudeContextWindow) {
    updateComposerState((state) =>
      state.provider !== "claude"
        ? state
        : withNormalizedContextWindow(
            {
              ...state,
              modelOptions: { ...state.modelOptions, contextWindow },
            },
            state.model,
          ),
    );
  }

  function setEffectivePlanMode(planMode: boolean) {
    const previousPlanMode = providerPrefs.planMode;
    setChatComposerPlanMode(composerChatId, planMode);
    if (!providerLocked || !chatId || !onRuntimePlanModeChange) return;
    void onRuntimePlanModeChange(planMode).catch(() => {
      setChatComposerPlanMode(composerChatId, previousPlanMode);
    });
  }

  function toggleEffectivePlanMode() {
    setEffectivePlanMode(!providerPrefs.planMode);
  }

  function modelOptionsPayloadForState(state: ComposerState): ModelOptions {
    if (state.provider === "claude")
      return { claude: { ...state.modelOptions } };
    if (state.provider === "codex") return { codex: { ...state.modelOptions } };
    return { opencode: { ...DEFAULT_OPENCODE_MODEL_OPTIONS } };
  }

  function applyRuntimeComposerState(nextState: ComposerState) {
    setComposerState(composerChatId, nextState);
    if (!providerLocked || !onRuntimePreferenceChange) return;
    void onRuntimePreferenceChange({
      provider: nextState.provider,
      model: nextState.model,
      modelOptions: modelOptionsPayloadForState(nextState),
    });
  }

  const processUploadQueue = useCallback(() => {
    if (!projectId) return;

    while (
      activeUploadsRef.current < MAX_CONCURRENT_UPLOADS &&
      uploadQueueRef.current.length > 0
    ) {
      const file = uploadQueueRef.current.shift();
      if (!file) break;

      activeUploadsRef.current += 1;
      const tempId = crypto.randomUUID();
      const previewUrl = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;
      const generation = uploadGenerationRef.current;

      setAttachments((current) => [
        ...current,
        {
          id: tempId,
          kind: file.type.startsWith("image/") ? "image" : "file",
          displayName: file.name,
          absolutePath: "",
          relativePath: "",
          contentUrl: "",
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          status: "uploading",
          previewUrl,
        },
      ]);

      void (async () => {
        try {
          const formData = new FormData();
          formData.append("files", file);

          const response = await fetch(`/api/projects/${projectId}/uploads`, {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(
              typeof payload.error === "string"
                ? payload.error
                : t.composer.uploadFailed,
            );
          }

          const payload = (await response.json()) as {
            attachments: ChatAttachment[];
          };
          const uploaded = payload.attachments[0];
          if (!uploaded || !isUsableUploadedAttachment(uploaded)) {
            throw new Error(t.composer.uploadFailed);
          }

          if (generation !== uploadGenerationRef.current) {
            void deleteUploadedAttachment(uploaded);
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            return;
          }

          if (removedAttachmentIdsRef.current.has(tempId)) {
            removedAttachmentIdsRef.current.delete(tempId);
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            void deleteUploadedAttachment(uploaded);
            return;
          }

          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id !== tempId
                ? attachment
                : {
                    ...attachment,
                    ...uploaded,
                    previewUrl: attachment.previewUrl,
                    status: "uploaded",
                  },
            ),
          );
          setUploadError(null);
        } catch (error) {
          if (generation !== uploadGenerationRef.current) {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            return;
          }
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === tempId
                ? { ...attachment, status: "failed" }
                : attachment,
            ),
          );
          setUploadError(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
          processUploadQueue();
        }
      })();
    }
  }, [projectId, t]);

  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (!projectId) {
        setUploadError(t.composer.openProjectBeforeUpload);
        return;
      }

      if (
        willExceedAttachmentLimit({
          currentAttachmentCount: attachmentsRef.current.length,
          queuedAttachmentCount: uploadQueueRef.current.length,
          incomingAttachmentCount: files.length,
        })
      ) {
        setUploadError(t.composer.uploadLimit(MAX_FILES_PER_DROP));
        return;
      }

      uploadQueueRef.current.push(...files);
      setUploadError(null);
      processUploadQueue();
    },
    [processUploadQueue, projectId, t],
  );

  const insertText = useCallback(
    (insertedText: string) => {
      if (!insertedText) return;

      const textarea = textareaRef.current;
      const selectionStart = textarea?.selectionStart ?? value.length;
      const selectionEnd = textarea?.selectionEnd ?? selectionStart;
      const nextValue = replaceTextSelection({
        value,
        insertedText,
        selectionStart,
        selectionEnd,
      });
      const nextCaretPosition = selectionStart + insertedText.length;

      setValue(nextValue);
      if (chatId) setDraft(chatId, nextValue);

      requestAnimationFrame(() => {
        autoResize();
        onLayoutChange?.();
        const currentTextarea = textareaRef.current;
        if (!currentTextarea) return;
        currentTextarea.focus();
        currentTextarea.selectionStart = nextCaretPosition;
        currentTextarea.selectionEnd = nextCaretPosition;
      });
    },
    [autoResize, chatId, onLayoutChange, setDraft, value],
  );

  const appendText = useCallback(
    (insertedText: string) => {
      if (!insertedText) return;

      const prefix = value.length > 0 && !value.endsWith("\n") ? "\n" : "";
      const suffix = insertedText.endsWith("\n") ? "" : "\n";
      const nextValue = `${value}${prefix}${insertedText}${suffix}`;
      const nextCaretPosition = nextValue.length;

      setValue(nextValue);
      if (chatId) setDraft(chatId, nextValue);

      requestAnimationFrame(() => {
        autoResize();
        onLayoutChange?.();
        const currentTextarea = textareaRef.current;
        if (!currentTextarea) return;
        currentTextarea.focus();
        currentTextarea.selectionStart = nextCaretPosition;
        currentTextarea.selectionEnd = nextCaretPosition;
      });
    },
    [autoResize, chatId, onLayoutChange, setDraft, value],
  );

  const hydrateDraft = useCallback(
    (text: string, draftAttachments: ChatAttachment[]) => {
      uploadGenerationRef.current += 1;
      uploadQueueRef.current = [];
      activeUploadsRef.current = 0;
      removedAttachmentIdsRef.current.clear();
      setValue(text);
      if (chatId) {
        setDraft(chatId, text);
        setAttachmentDrafts(chatId, draftAttachments);
      }
      setAttachments((current) => {
        current.forEach(cleanupAttachmentPreview);
        return hydrateComposerAttachments(draftAttachments);
      });
      setSelectedAttachmentId(null);
      setUploadError(null);
      requestAnimationFrame(() => {
        autoResize();
        onLayoutChange?.();
        textareaRef.current?.focus();
      });
    },
    [
      autoResize,
      chatId,
      cleanupAttachmentPreview,
      onLayoutChange,
      setAttachmentDrafts,
      setDraft,
    ],
  );

  const hasUnsavedDraft = useCallback(
    () => value.trim().length > 0 || attachmentsRef.current.length > 0,
    [value],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      appendText,
      enqueueFiles,
      hasUnsavedDraft,
      hydrateDraft,
      insertText,
    }),
    [appendText, enqueueFiles, hasUnsavedDraft, hydrateDraft, insertText],
  );

  async function handleSubmit() {
    if (submissionDisabled || !canSubmit || hasPendingUploads) return;

    const nextValue = value;
    const previousAttachments = attachmentsRef.current;
    const previousSelectedAttachmentId = selectedAttachmentId;
    const previousUploadError = uploadError;
    const attachmentsForSubmit = uploadedAttachments.map(
      ({ previewUrl: _previewUrl, status: _status, ...attachment }) =>
        attachment,
    );
    let modelOptions: ModelOptions;
    if (providerPrefs.provider === "claude") {
      modelOptions = { claude: { ...providerPrefs.modelOptions } };
    } else if (providerPrefs.provider === "codex") {
      modelOptions = { codex: { ...providerPrefs.modelOptions } };
    } else {
      modelOptions = { opencode: { ...DEFAULT_OPENCODE_MODEL_OPTIONS } };
    }
    const submitOptions = {
      provider: selectedProvider,
      model: providerPrefs.model,
      modelOptions,
      planMode: showPlanMode ? providerPrefs.planMode : false,
      attachments: attachmentsForSubmit,
    };
    const submittedComposerState: ComposerState = {
      ...providerPrefs,
      modelOptions: { ...providerPrefs.modelOptions },
      planMode: submitOptions.planMode,
    } as ComposerState;
    setValue("");
    if (chatId) clearDraft(chatId);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    clearAttachments({ cleanupPreviews: false });
    if (latestChatIdRef.current) {
      clearAttachmentDrafts(latestChatIdRef.current);
    }

    try {
      await onSubmit(nextValue, submitOptions);
      setComposerState(composerChatId, submittedComposerState);
      previousAttachments.forEach(cleanupAttachmentPreview);
    } catch (error) {
      console.error("[ChatInput] Submit failed:", error);
      setValue(nextValue);
      if (chatId) setDraft(chatId, nextValue);
      setAttachments(previousAttachments);
      setSelectedAttachmentId(previousSelectedAttachmentId);
      setUploadError(previousUploadError);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      focusNextChatInput(textareaRef.current, document);
      return;
    }

    if (event.key === "Tab" && event.shiftKey && showPlanMode) {
      event.preventDefault();
      toggleEffectivePlanMode();
      return;
    }

    if (event.key === "Escape" && canCancel) {
      event.preventDefault();
      onCancel?.();
      return;
    }

    if (
      event.key === "ArrowUp" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      onJumpToPreviousUserPrompt
    ) {
      event.preventDefault();
      void onJumpToPreviousUserPrompt();
      return;
    }

    if (
      event.key === "ArrowUp" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      value.length === 0 &&
      previousPrompt
    ) {
      event.preventDefault();
      setValue(previousPrompt);
      if (chatId) setDraft(chatId, previousPrompt);
      return;
    }

    const isTouchDevice =
      "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !isTouchDevice &&
      !submissionDisabled &&
      hasTextToSend &&
      !hasPendingUploads
    ) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = getClipboardImageFiles(event.clipboardData.items, Date.now());
    const pastedText = event.clipboardData.getData("text/plain");
    const trimmedText = trimTrailingPastedNewlines(pastedText);
    const shouldTrimTrailingNewlines =
      pastedText.length > 0 && trimmedText !== pastedText;

    if (pastedText.length >= PASTED_TEXT_FILE_THRESHOLD) {
      event.preventDefault();
      enqueueFiles([createPastedTextFile(pastedText)]);
      return;
    }

    if (files.length === 0 && !shouldTrimTrailingNewlines) return;

    if (files.length > 0) {
      enqueueFiles(files);
    }

    if (shouldTrimTrailingNewlines) {
      event.preventDefault();
      const textarea = event.currentTarget;
      const nextValue = replaceTextSelection({
        value,
        insertedText: trimmedText,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      });
      const nextCaretPosition = textarea.selectionStart + trimmedText.length;
      setValue(nextValue);
      if (chatId) setDraft(chatId, nextValue);
      autoResize();
      requestAnimationFrame(() => {
        textarea.selectionStart = nextCaretPosition;
        textarea.selectionEnd = nextCaretPosition;
      });
      return;
    }

    if (!hasClipboardTextPayload(event.clipboardData)) {
      event.preventDefault();
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLTextAreaElement>) {
    const projectPathDragTypes = [
      "application/x-abolqasem-project-path",
      "application/x-ai-agent-manager-project-path",
    ];
    if (
      !Array.from(event.dataTransfer.types).some((type) =>
        projectPathDragTypes.includes(type),
      )
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(event: React.DragEvent<HTMLTextAreaElement>) {
    const projectPath =
      event.dataTransfer.getData("application/x-abolqasem-project-path") ||
      event.dataTransfer.getData("application/x-ai-agent-manager-project-path");
    if (!projectPath) return;

    event.preventDefault();
    insertText(` ${projectPath} `);
  }

  function handleAttachmentPreview(attachment: ComposerAttachment) {
    const target = classifyAttachmentPreview(attachment);
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(
          new URL(attachment.contentUrl, window.location.origin).toString(),
          "_blank",
          "noopener,noreferrer",
        );
      }
      return;
    }

    setSelectedAttachmentId(attachment.id);
  }

  function removeAttachment(attachment: ComposerAttachment) {
    removedAttachmentIdsRef.current.add(attachment.id);
    setAttachments((current) => {
      const removed = current.find((item) => item.id === attachment.id);
      if (removed) cleanupAttachmentPreview(removed);
      return current.filter((item) => item.id !== attachment.id);
    });
    if (selectedAttachmentId === attachment.id) {
      setSelectedAttachmentId(null);
    }

    if (attachment.status === "uploaded") {
      removedAttachmentIdsRef.current.delete(attachment.id);
      void deleteUploadedAttachment(attachment);
    }
  }

  return (
    <div>
      <div className={cn("px-3 pt-0", isStandalone && "px-5")}>
        <div className="max-w-[840px] mx-auto rounded-[32px]">
          {connectionUnavailable ? (
            <div
              role="status"
              aria-live="polite"
              className="mb-1.5 flex items-center justify-center gap-1.5 px-3 text-xs text-amber-600 dark:text-amber-300"
            >
              {connectionStatus === "connecting" ? (
                <LoaderCircle
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{connectionStatusLabel}</span>
            </div>
          ) : null}
          {!connectionUnavailable ? (
            <AgentActivityIndicator
              runtimeStatus={runtimeStatus}
              activity={processingStatus}
              provider={activeProvider}
              startedAt={turnStartedAt}
            />
          ) : null}
          {attachments.length > 0 ? (
            <ScrollArea className="overflow-x-auto overflow-y-hidden whitespace-nowrap px-2 pb-2">
              <div className="flex items-end gap-2 pt-2">
                {orderedAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className={cn(
                      "flex shrink-0 flex-col justify-end",
                      attachment.status === "failed" && "text-destructive",
                    )}
                  >
                    {attachment.kind === "image" ? (
                      <AttachmentImageCard
                        attachment={attachment}
                        previewUrl={attachment.previewUrl}
                        size="composer"
                        onClick={
                          attachment.status === "uploaded"
                            ? () => handleAttachmentPreview(attachment)
                            : undefined
                        }
                        onRemove={() => removeAttachment(attachment)}
                      />
                    ) : (
                      <AttachmentFileCard
                        attachment={attachment}
                        onClick={
                          attachment.status === "uploaded"
                            ? () => handleAttachmentPreview(attachment)
                            : undefined
                        }
                        onRemove={() => removeAttachment(attachment)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : null}

          <div
            className={cn(
              "flex items-end max-w-[840px] mx-auto border dark:bg-card/40 backdrop-blur-lg rounded-[29px] px-1.5 transition-colors duration-200",
              "border-border",
            )}
          >
            <label
              aria-label={t.composer.addAttachment}
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon" }),
                "relative md:hidden flex-shrink-0 mx-1 mb-1 h-10 w-10 rounded-full text-muted-foreground hover:text-foreground",
                submissionDisabled && "pointer-events-none opacity-50",
              )}
            >
              <Paperclip className="h-5 w-5" />
              <input
                type="file"
                multiple
                disabled={submissionDisabled}
                aria-label={t.composer.addAttachment}
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  if (files.length > 0) {
                    enqueueFiles(files);
                  }
                  event.target.value = "";
                }}
              />
            </label>
            <Textarea
              ref={setTextareaRefs}
              placeholder={lockedPlaceholder}
              value={value}
              autoFocus
              {...{ [CHAT_INPUT_ATTRIBUTE]: "" }}
              rows={1}
              onChange={(event) => {
                setValue(event.target.value);
                if (chatId) setDraft(chatId, event.target.value);
                autoResize();
              }}
              onPaste={handlePaste}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onKeyDown={handleKeyDown}
              disabled={inputDisabled}
              className="flex-1 text-base px-2 py-3 md:px-4 md:py-4 resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none disabled:cursor-not-allowed disabled:opacity-60"
            />
            {readOnly && (isLockedElsewhere || isLockUnknown) ? (
              <TooltipProvider delayDuration={200}>
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1",
                    isRtl
                      ? "mb-1 -ml-0.5 md:mb-1.5 md:ml-0"
                      : "mb-1 -mr-0.5 md:mb-1.5 md:mr-0",
                  )}
                >
                  <Button
                    type="button"
                    onClick={() => {
                      if (lockBusy) return;
                      if (isLockedElsewhere)
                        onTakeOverSession?.(selectedCodexExecutionMode);
                      else onRefreshSessionLock?.();
                    }}
                    disabled={
                      lockBusy ||
                      (isLockedElsewhere
                        ? !codexLock?.canTakeOver || !onTakeOverSession
                        : !onRefreshSessionLock)
                    }
                    size="icon"
                    aria-label={effectiveLockActionLabel}
                    title={effectiveLockActionLabel}
                    className="h-10 w-10 cursor-pointer rounded-full bg-muted text-muted-foreground touch-manipulation hover:bg-muted/80 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 md:h-11 md:w-11"
                  >
                    {lockBusy ? (
                      <LoaderCircle
                        className="h-5 w-5 animate-spin md:h-6 md:w-6"
                        aria-hidden="true"
                      />
                    ) : isLockedElsewhere ? (
                      <LockKeyhole
                        className="h-5 w-5 md:h-6 md:w-6"
                        aria-hidden="true"
                      />
                    ) : (
                      <RefreshCw
                        className="h-5 w-5 md:h-6 md:w-6"
                        aria-hidden="true"
                      />
                    )}
                  </Button>
                  {isLockedElsewhere ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            if (!lockBusy) onRefreshSessionLock?.();
                          }}
                          disabled={lockBusy || !onRefreshSessionLock}
                          aria-label={refreshSessionTextLabel}
                          title={refreshSessionTextLabel}
                          className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-50"
                        >
                          {lockBusy ? (
                            <LoaderCircle
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <RefreshCw
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent dir={isRtl ? "rtl" : "ltr"}>
                        {refreshSessionTextLabel}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              </TooltipProvider>
            ) : (
              <Button
                type="button"
                onPointerDown={(event) => {
                  event.preventDefault();
                  if (
                    !submissionDisabled &&
                    hasTextToSend &&
                    !hasPendingUploads
                  ) {
                    void handleSubmit();
                  } else if (!connectionUnavailable && canCancel) {
                    onCancel?.();
                  } else if (
                    !submissionDisabled &&
                    canSubmit &&
                    !hasPendingUploads
                  ) {
                    void handleSubmit();
                  }
                }}
                disabled={
                  submissionDisabled ||
                  (!canCancel && !canSubmit) ||
                  hasPendingUploads
                }
                aria-label={
                  connectionUnavailable ? connectionStatusLabel : undefined
                }
                title={
                  connectionUnavailable ? connectionStatusLabel : undefined
                }
                size="icon"
                className={cn(
                  "h-10 w-10 flex-shrink-0 cursor-pointer rounded-full bg-slate-600 text-white touch-manipulation disabled:bg-white/60 disabled:text-slate-700 md:h-11 md:w-11 dark:bg-white dark:text-slate-900",
                  isRtl
                    ? "mb-1 -ml-0.5 md:mb-1.5 md:ml-0"
                    : "mb-1 -mr-0.5 md:mb-1.5 md:mr-0",
                )}
              >
                {connectionStatus === "connecting" ? (
                  <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none md:h-6 md:w-6" />
                ) : connectionStatus === "disconnected" ? (
                  <WifiOff className="h-5 w-5 md:h-6 md:w-6" />
                ) : hasTextToSend ? (
                  <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
                ) : canCancel ? (
                  <div className="h-3 w-3 rounded-xs bg-current md:h-4 md:w-4" />
                ) : (
                  <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
                )}
              </Button>
            )}
          </div>
        </div>

        {uploadError ? (
          <div className="max-w-[840px] mx-auto mt-2 px-1 text-sm text-destructive">
            {uploadError}
          </div>
        ) : null}
      </div>

      {showPreferenceControls ? (
        <div
          className={cn(
            "relative py-3 max-w-[840px] mx-auto",
            isStandalone && "p-5 pt-3",
          )}
        >
          <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex flex-row">
            <div className="min-w-3" />
            {codexLock && codexLock.state !== "available" ? (
              isOwnedByUs ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    connectionUnavailable ||
                    lockBusy ||
                    !codexLock.canRelease ||
                    !onReleaseSession
                  }
                  onClick={onReleaseSession}
                  title={t.composer.releaseSession}
                  aria-label={t.composer.releaseSession}
                  className="mx-1 h-8 w-8 shrink-0 cursor-pointer rounded-md p-0 text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed"
                >
                  {lockBusy ? (
                    <LoaderCircle
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              ) : (
                <span
                  className="mx-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground"
                  role="img"
                  aria-label={
                    isLockedElsewhere
                      ? t.composer.lockedElsewhere
                      : t.composer.sessionLockUnknown
                  }
                  title={
                    isLockedElsewhere
                      ? t.composer.lockedElsewhere
                      : t.composer.sessionLockUnknown
                  }
                >
                  {isLockedElsewhere ? (
                    <LockKeyholeOpen
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </span>
              )
            ) : null}
            {providerPrefs.provider === "codex" &&
            isOwnedByUs &&
            onReloadCodexAuth ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={
                  connectionUnavailable || lockBusy || Boolean(canCancel)
                }
                onClick={onReloadCodexAuth}
                title={
                  lockBusy
                    ? "در حال بازنشانی حساب Codex…"
                    : t.composer.reloadCodexAccount
                }
                aria-label={
                  lockBusy
                    ? "در حال بازنشانی حساب Codex…"
                    : t.composer.reloadCodexAccount
                }
                aria-busy={lockBusy}
                className="mx-1 h-8 w-8 shrink-0 cursor-pointer rounded-md p-0 text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed"
              >
                {lockBusy ? (
                  <LoaderCircle
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>
            ) : null}
            <ChatPreferenceControls
              availableProviders={availableProviders}
              selectedProvider={selectedProvider}
              disabled={connectionUnavailable}
              providerLocked={providerLocked}
              showCodexCliRequirementHints
              model={providerPrefs.model}
              modelOptions={
                providerPrefs.provider === "codex"
                  ? {
                      ...providerPrefs.modelOptions,
                      executionMode: effectiveCodexExecutionMode,
                    }
                  : providerPrefs.modelOptions
              }
              onProviderChange={(provider) => {
                if (providerLocked) return;
                resetChatComposerFromProvider(composerChatId, provider);
              }}
              onModelChange={(_, model) => {
                if (providerLocked) {
                  applyRuntimeComposerState(
                    withNormalizedContextWindow(providerPrefs, model),
                  );
                  return;
                }
                setChatComposerModel(composerChatId, model);
              }}
              onModelOptionChange={(change) => {
                switch (change.type) {
                  case "claudeReasoningEffort":
                    if (providerLocked && providerPrefs.provider === "claude") {
                      applyRuntimeComposerState({
                        ...providerPrefs,
                        modelOptions: {
                          ...providerPrefs.modelOptions,
                          reasoningEffort: change.effort,
                        },
                      });
                      break;
                    }
                    setReasoningEffort(change.effort);
                    break;
                  case "codexReasoningEffort":
                    if (providerLocked && providerPrefs.provider === "codex") {
                      applyRuntimeComposerState({
                        ...providerPrefs,
                        modelOptions: {
                          ...providerPrefs.modelOptions,
                          reasoningEffort: change.effort,
                        },
                      });
                      break;
                    }
                    setReasoningEffort(change.effort);
                    break;
                  case "contextWindow":
                    if (providerLocked && providerPrefs.provider === "claude") {
                      applyRuntimeComposerState(
                        withNormalizedContextWindow(
                          {
                            ...providerPrefs,
                            modelOptions: {
                              ...providerPrefs.modelOptions,
                              contextWindow: change.contextWindow,
                            },
                          },
                          providerPrefs.model,
                        ),
                      );
                      break;
                    }
                    setClaudeContextWindow(change.contextWindow);
                    break;
                  case "fastMode":
                    if (providerLocked && providerPrefs.provider === "codex") {
                      applyRuntimeComposerState({
                        ...providerPrefs,
                        modelOptions: {
                          ...providerPrefs.modelOptions,
                          fastMode: change.fastMode,
                        },
                      });
                      break;
                    }
                    updateComposerState((state) =>
                      state.provider !== "codex"
                        ? state
                        : {
                            ...state,
                            modelOptions: {
                              ...state.modelOptions,
                              fastMode: change.fastMode,
                            },
                          },
                    );
                    break;
                  case "executionMode":
                    if (
                      providerPrefs.provider === "codex" &&
                      shouldApplyCodexExecutionModeToRuntime(
                        providerLocked,
                        providerPrefs.provider,
                        codexLock?.state,
                      )
                    ) {
                      applyRuntimeComposerState({
                        ...providerPrefs,
                        modelOptions: {
                          ...providerPrefs.modelOptions,
                          executionMode: change.executionMode,
                        },
                      });
                      onCodexExecutionModeChange?.(change.executionMode);
                      break;
                    }
                    // Without ownership this is the mode to use on the next
                    // claim/takeover, not a command for the currently owning
                    // Codex process.
                    updateComposerState((state) =>
                      state.provider !== "codex"
                        ? state
                        : {
                            ...state,
                            modelOptions: {
                              ...state.modelOptions,
                              executionMode: change.executionMode,
                            },
                          },
                    );
                    break;
                }
              }}
              runtimeMode={providerLocked}
              executionModeBusy={
                isOwnedByUs && (lockBusy || Boolean(canCancel))
              }
              onRuntimeShortcut={(provider, model, effort) => {
                if (providerPrefs.provider !== provider) return;
                if (
                  provider === "codex" &&
                  providerPrefs.provider === "codex" &&
                  effort
                ) {
                  applyRuntimeComposerState({
                    ...providerPrefs,
                    model,
                    modelOptions: {
                      ...providerPrefs.modelOptions,
                      reasoningEffort: effort,
                    },
                  });
                  return;
                }
                applyRuntimeComposerState(
                  withNormalizedContextWindow(providerPrefs, model),
                );
              }}
              planMode={providerPrefs.planMode}
              onPlanModeChange={setEffectivePlanMode}
              includePlanMode={showPlanMode}
              className="max-w-[840px] mx-auto"
            />
            {activeContextWindow || rateLimitSnapshot || accountEmail ? (
              <div className="flex items-center md:hidden mx-[13px]">
                <SessionHealthPopover
                  snapshot={rateLimitSnapshot}
                  contextUsage={activeContextWindow}
                  accountEmail={accountEmail}
                  onAccountActivated={onAccountActivated}
                />
              </div>
            ) : null}
            <div className="min-w-3" />
          </div>

          {activeContextWindow || rateLimitSnapshot || accountEmail ? (
            <div
              className={cn(
                "absolute top-1/2 -translate-y-1/2 hidden items-center md:flex",
                isRtl
                  ? "left-[29px] -translate-x-1/2"
                  : "right-[29px] translate-x-1/2",
              )}
            >
              <SessionHealthPopover
                snapshot={rateLimitSnapshot}
                contextUsage={activeContextWindow}
                accountEmail={accountEmail}
                onAccountActivated={onAccountActivated}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <AttachmentPreviewModal
        attachment={selectedAttachment}
        onOpenChange={(open) => !open && setSelectedAttachmentId(null)}
      />
    </div>
  );
});

export const ChatInput = memo(ChatInputInner);

async function deleteUploadedAttachment(attachment: ChatAttachment) {
  if (!attachment.contentUrl) return;
  const deleteUrl = attachment.contentUrl.replace(/\/content$/, "");
  await fetch(deleteUrl, { method: "DELETE" }).catch(() => undefined);
}

/** Reject incomplete server metadata instead of rendering a misleading 0 B card. */
export function isUsableUploadedAttachment(
  attachment: ChatAttachment,
): boolean {
  if (!attachment.contentUrl || !attachment.displayName || attachment.size < 0)
    return false;
  if (
    attachment.kind === "image" ||
    attachment.mimeType.toLowerCase().startsWith("image/")
  ) {
    return attachment.size > 0;
  }
  return true;
}

function hydrateComposerAttachments(
  attachments: ChatAttachment[],
): ComposerAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    status: "uploaded" as const,
  }));
}
