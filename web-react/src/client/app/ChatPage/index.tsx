import {
  memo,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { type LegendListRef } from "@legendapp/list/react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { useOutletContext } from "react-router-dom";
import { ExternalLink, Loader2, MessageSquarePlus, X } from "lucide-react";
import type { ChatInputHandle } from "../../components/chat-ui/ChatInput";
import {
  ChatNavbar,
  type ChatSearchMatch,
} from "../../components/chat-ui/ChatNavbar";
import type { MessageIndexItem } from "../../components/chat-ui/ConversationMinimap";
import type { GitPanel } from "../../components/chat-ui/GitPanel";
import type { ProjectFileEntry } from "../../components/chat-ui/ProjectFilesPanel";
import { readProjectFilePreview } from "../../components/chat-ui/projectFilesData";
import {
  fileRouteHref,
  type FilePreviewResponse,
} from "../../components/file-preview/FilePreviewPanel";
import { useAppDialog } from "../../components/ui/app-dialog";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import {
  getAppearanceThemeClassName,
  useReaderAppearanceSettings,
} from "../../components/appearance/ReaderAppearance";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../components/ui/resizable";
import {
  actionMatchesEvent,
  getResolvedKeybindings,
} from "../../lib/keybindings";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import {
  deriveLatestRateLimitSnapshot,
  type UsageSnapshot,
} from "../../lib/usage";
import { cn } from "../../lib/utils";
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  useRightSidebarStore,
} from "../../stores/rightSidebarStore";
import {
  DEFAULT_PROJECT_TERMINAL_LAYOUT,
  useTerminalLayoutStore,
} from "../../stores/terminalLayoutStore";
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore";
import { shouldCloseTerminalPane } from "../terminalLayoutResize";
import { TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "../terminalToggleAnimation";
import { CHAT_SELECTION_ZONE_ATTRIBUTE } from "../chatFocusPolicy";
import { useRightSidebarToggleAnimation } from "../useRightSidebarToggleAnimation";
import { useStickyChatFocus } from "../useStickyChatFocus";
import { useTerminalToggleAnimation } from "../useTerminalToggleAnimation";
import type { AbolqasemState } from "../useAbolqasemState";
import {
  getNextMeasuredInputHeight,
  getTranscriptPaddingBottom,
} from "../useAbolqasemState";
import type { AgentProvider, CodexExecutionMode } from "../../../shared/types";
import { ChatInputDock } from "./ChatInputDock";
import { getProcessingStatus } from "./processingStatus";
import {
  getOrderedRightSidebarLayout,
  getRightSidebarPanelDefaultSizes,
  type RightSidebarLayoutDirection,
} from "./rightSidebarLayout";
import {
  findLoadedTranscriptMessageById,
  findPreviousUserPromptMessage,
  findTranscriptRowTarget,
  type TranscriptRowTarget,
} from "./transcriptNavigation";
import {
  useChatPageSidebarActions,
  EMPTY_DIFF_SNAPSHOT,
} from "./useChatPageSidebarActions";
import {
  EMPTY_STATE_TYPING_INTERVAL_MS,
  hasFileDragTypes,
  getTranscriptTailVersion,
  isAbsoluteLocalPath,
  resolveDiffFilePath,
  sameContextWindowSnapshot,
  shouldShowTranscriptUnreadIndicator,
} from "./utils";
import { useI18n } from "../../i18n/context";

// Terminal and diff rendering pull in xterm and the diff engine. They are
// useful only after a user opens the corresponding pane, so keep them out of
// the chat's startup execution path.
const LazyGitPanel = lazy(() => import("../../components/chat-ui/GitPanel").then((module) => ({ default: module.GitPanel })));
const LazyTerminalWorkspaceShell = lazy(() => import("./TerminalWorkspaceShell").then((module) => ({ default: module.TerminalWorkspaceShell })));
// Message rendering imports markdown, syntax highlighting, and the full tool
// renderer tree. Keep that parse/evaluation work behind a boundary so the
// shell and composer become interactive before a long transcript is mounted.
const LazyChatTranscriptViewport = lazy(() => import("./ChatTranscriptViewport").then((module) => ({ default: module.ChatTranscriptViewport })));
// These panes are opt-in UI. Statically importing them made every fresh chat
// parse file previews and browser controls even when their panel stayed shut.
const LazyBrowserPanel = lazy(() => import("../../components/chat-ui/BrowserPanel").then((module) => ({ default: module.BrowserPanel })));
const LazyProjectFilesPanel = lazy(() => import("../../components/chat-ui/ProjectFilesPanel").then((module) => ({ default: module.ProjectFilesPanel })));
const LazyFilePreviewPanel = lazy(() => import("../../components/file-preview/FilePreviewPanel").then((module) => ({ default: module.FilePreviewPanel })));

export {
  getOrderedRightSidebarLayout,
  getRightSidebarPanelDefaultSizes,
} from "./rightSidebarLayout";
export {
  getIgnoreFolderEntryFromDiffPath,
  getTranscriptTailVersion,
  hasFileDragTypes,
  shouldAutoFollowTranscriptResize,
  shouldShowTranscriptUnreadIndicator,
} from "./utils";

const PROJECT_FILE_PREVIEW_NAVBAR_OFFSET_PX = 52;
function useEmptyStateTyping(
  showEmptyState: boolean,
  activeChatId: string | null,
  emptyStateText: string,
) {
  const [typedEmptyStateText, setTypedEmptyStateText] = useState("");
  const [isEmptyStateTypingComplete, setIsEmptyStateTypingComplete] =
    useState(false);

  useEffect(() => {
    if (!showEmptyState) return;

    setTypedEmptyStateText("");
    setIsEmptyStateTypingComplete(false);

    let characterIndex = 0;
    const interval = window.setInterval(() => {
      characterIndex += 1;
      setTypedEmptyStateText(emptyStateText.slice(0, characterIndex));

      if (characterIndex >= emptyStateText.length) {
        window.clearInterval(interval);
        setIsEmptyStateTypingComplete(true);
      }
    }, EMPTY_STATE_TYPING_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [showEmptyState, activeChatId, emptyStateText]);

  return { typedEmptyStateText, isEmptyStateTypingComplete };
}

function usePageFileDrop(args: {
  hasSelectedProject: boolean;
  onFilesDropped: (files: File[]) => void;
}) {
  const [isPageFileDragActive, setIsPageFileDragActive] = useState(false);
  const pageFileDragDepthRef = useRef(0);

  const hasDraggedFiles = useCallback(
    (event: DragEvent) => hasFileDragTypes(event.dataTransfer?.types ?? []),
    [],
  );

  const handleTranscriptDragEnter = useCallback(
    (event: DragEvent) => {
      if (!hasDraggedFiles(event) || !args.hasSelectedProject) return;
      event.preventDefault();
      pageFileDragDepthRef.current += 1;
      setIsPageFileDragActive(true);
    },
    [args.hasSelectedProject, hasDraggedFiles],
  );

  const handleTranscriptDragOver = useCallback(
    (event: DragEvent) => {
      if (!hasDraggedFiles(event) || !args.hasSelectedProject) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!isPageFileDragActive) {
        setIsPageFileDragActive(true);
      }
    },
    [args.hasSelectedProject, hasDraggedFiles, isPageFileDragActive],
  );

  const handleTranscriptDragLeave = useCallback(
    (event: DragEvent) => {
      if (!hasDraggedFiles(event) || !args.hasSelectedProject) return;
      event.preventDefault();
      pageFileDragDepthRef.current = Math.max(
        0,
        pageFileDragDepthRef.current - 1,
      );
      if (pageFileDragDepthRef.current === 0) {
        setIsPageFileDragActive(false);
      }
    },
    [args.hasSelectedProject, hasDraggedFiles],
  );

  const handleTranscriptDrop = useCallback(
    (event: DragEvent) => {
      if (!hasDraggedFiles(event) || !args.hasSelectedProject) return;
      event.preventDefault();
      pageFileDragDepthRef.current = 0;
      setIsPageFileDragActive(false);
      args.onFilesDropped([...event.dataTransfer.files]);
    },
    [args, hasDraggedFiles],
  );

  return {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  };
}

function useLayoutWidth(ref: RefObject<HTMLDivElement | null>) {
  const [layoutWidth, setLayoutWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = element.clientWidth;
      setLayoutWidth((current) =>
        Math.abs(current - nextWidth) < 1 ? current : nextWidth,
      );
    };

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    updateWidth();

    return () => observer.disconnect();
  }, [ref]);

  return layoutWidth;
}

function useTranscriptPaddingBottom() {
  const inputRef = useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = useState(148);

  const syncInputHeight = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;
    const measuredHeight = element.getBoundingClientRect().height;
    setInputHeight((current) =>
      getNextMeasuredInputHeight(current, measuredHeight),
    );
  }, []);

  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;

    const observer = new ResizeObserver(() => {
      syncInputHeight();
    });
    observer.observe(element);
    syncInputHeight();
    return () => observer.disconnect();
  }, [syncInputHeight]);

  return {
    inputRef,
    syncInputHeight,
    transcriptPaddingBottom: getTranscriptPaddingBottom(inputHeight),
  };
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

interface ProjectFilePreviewTarget {
  path: string;
  name: string;
}

interface ProjectPreviewSelectionMenu {
  x: number;
  y: number;
  text: string;
  promptText: string;
  reference: string;
}

function normalizeReferencePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function projectRelativeReferencePath(
  path: string,
  projectRoot: string | null | undefined,
) {
  const normalizedPath = normalizeReferencePath(path);
  const normalizedRoot = projectRoot
    ? normalizeReferencePath(projectRoot).replace(/\/+$/, "")
    : "";

  if (normalizedRoot && normalizedPath === normalizedRoot) {
    return normalizedPath.split("/").filter(Boolean).pop() ?? normalizedPath;
  }
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

function lineReferenceSuffix(startLine: number | null, endLine: number | null) {
  if (!startLine || !endLine) return "";
  return startLine === endLine ? `:${startLine}` : `:${startLine}-${endLine}`;
}

function selectionRangeRect(
  selection: Selection,
  fallbackClientX?: number,
  fallbackClientY?: number,
) {
  if (selection.rangeCount === 0) {
    return fallbackClientX !== undefined && fallbackClientY !== undefined
      ? new DOMRect(fallbackClientX, fallbackClientY, 0, 0)
      : null;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) return rect;

  const firstClientRect = range.getClientRects()[0];
  if (firstClientRect) return firstClientRect;

  return fallbackClientX !== undefined && fallbackClientY !== undefined
    ? new DOMRect(fallbackClientX, fallbackClientY, 0, 0)
    : null;
}

function clampSelectionMenuPosition(rect: DOMRect) {
  const menuWidth = 268;
  const menuHeight = 64;
  const viewportPadding = 12;
  const centeredX = rect.left + rect.width / 2 - menuWidth / 2;
  const aboveY = rect.top - menuHeight - 10;
  const belowY = rect.bottom + 10;
  const x = Math.max(
    viewportPadding,
    Math.min(centeredX, window.innerWidth - menuWidth - viewportPadding),
  );
  const y =
    aboveY >= viewportPadding
      ? aboveY
      : Math.max(
          viewportPadding,
          Math.min(belowY, window.innerHeight - menuHeight - viewportPadding),
        );

  return { x, y };
}

function codeLineNumberFromElement(
  element: HTMLElement,
  preview: FilePreviewResponse,
) {
  const relativeLine = Number(element.dataset.line);
  if (!Number.isFinite(relativeLine) || relativeLine <= 0) return null;
  return preview.start_line + relativeLine - 1;
}

function codeLineNumberFromNode(
  root: HTMLElement,
  node: Node | null,
  preview: FilePreviewResponse,
) {
  const element = node instanceof Element ? node : node?.parentElement;
  const lineElement = element?.closest<HTMLElement>("[data-line]");
  if (!lineElement || !root.contains(lineElement)) return null;
  return codeLineNumberFromElement(lineElement, preview);
}

function rectsOverlapVertically(first: DOMRect, second: DOMRect) {
  // A small tolerance keeps half-selected bottom lines from being dropped by sub-pixel rounding.
  const tolerance = 1;
  return (
    first.bottom >= second.top - tolerance &&
    first.top <= second.bottom + tolerance
  );
}

function lineRectOverlapsSelection(
  lineRect: DOMRect,
  selectionRects: DOMRect[],
) {
  return selectionRects.some(
    (selectionRect) =>
      (selectionRect.width > 0 || selectionRect.height > 0) &&
      rectsOverlapVertically(lineRect, selectionRect),
  );
}

function codeLineRangeFromSelection(
  root: HTMLElement,
  selection: Selection,
  preview: FilePreviewResponse,
) {
  if (preview.language === "markdown" || selection.rangeCount === 0)
    return null;

  const range = selection.getRangeAt(0);
  const selectedLines = new Set<number>();
  const selectionRects = Array.from(range.getClientRects());

  const anchorLine = codeLineNumberFromNode(
    root,
    selection.anchorNode,
    preview,
  );
  if (anchorLine) selectedLines.add(anchorLine);
  const focusLine = codeLineNumberFromNode(root, selection.focusNode, preview);
  if (focusLine) selectedLines.add(focusLine);

  for (const lineElement of Array.from(
    root.querySelectorAll<HTMLElement>("[data-line]"),
  )) {
    let intersects = false;
    try {
      intersects = range.intersectsNode(lineElement);
    } catch {
      intersects = false;
    }

    if (
      !intersects &&
      !lineRectOverlapsSelection(
        lineElement.getBoundingClientRect(),
        selectionRects,
      )
    ) {
      continue;
    }

    const lineNumber = codeLineNumberFromElement(lineElement, preview);
    if (lineNumber) {
      selectedLines.add(lineNumber);
    }
  }

  if (selectedLines.size === 0) return null;
  const lineNumbers = [...selectedLines];
  return {
    startLine: Math.min(...lineNumbers),
    endLine: Math.max(...lineNumbers),
  };
}

function normalizeSelectionText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

function sourceLineRangeFromSelectionText(
  preview: FilePreviewResponse,
  selectedText: string,
) {
  const source = preview.lines.map((line) => line.text).join("\n");
  const normalizedSource = normalizeSelectionText(source);
  const normalizedSelectedText = normalizeSelectionText(selectedText);
  if (!normalizedSource || !normalizedSelectedText) return null;

  const exactIndex = normalizedSource.indexOf(normalizedSelectedText);
  if (exactIndex >= 0) {
    const startLine =
      preview.start_line +
      normalizedSource.slice(0, exactIndex).split("\n").length -
      1;
    const selectedLineCount = normalizedSelectedText.split("\n").length;
    return { startLine, endLine: startLine + selectedLineCount - 1 };
  }

  const selectedLines = normalizedSelectedText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const firstSelectedLine = selectedLines[0];
  if (!firstSelectedLine) return null;

  const sourceLines = source.split(/\r\n?|\n/);
  const relativeIndex = sourceLines.findIndex((line) => {
    const normalizedLine = line.trim();
    if (!normalizedLine) return false;
    return (
      normalizedLine.includes(firstSelectedLine) ||
      firstSelectedLine.includes(normalizedLine)
    );
  });
  if (relativeIndex < 0) return null;

  const startLine = preview.start_line + relativeIndex;
  return {
    startLine,
    endLine: startLine + Math.max(selectedLines.length - 1, 0),
  };
}

function projectPreviewSelectionMenuFromSelection(args: {
  root: HTMLElement;
  preview: FilePreviewResponse | null;
  path: string;
  projectRoot?: string | null;
  fallbackClientX?: number;
  fallbackClientY?: number;
}) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !args.preview) return null;

  const selectedText = selection.toString();
  if (!selectedText || !selectedText.trim()) return null;

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (
    (anchorNode && !args.root.contains(anchorNode)) ||
    (focusNode && !args.root.contains(focusNode))
  ) {
    return null;
  }

  const rect = selectionRangeRect(
    selection,
    args.fallbackClientX,
    args.fallbackClientY,
  );
  if (!rect) return null;

  const codeLineRange = codeLineRangeFromSelection(
    args.root,
    selection,
    args.preview,
  );
  const fallbackLineRange =
    codeLineRange ??
    sourceLineRangeFromSelectionText(args.preview, selectedText);
  const referencePath = projectRelativeReferencePath(
    args.path || args.preview.path,
    args.projectRoot,
  );
  const reference = `${referencePath}${lineReferenceSuffix(fallbackLineRange?.startLine ?? null, fallbackLineRange?.endLine ?? null)}`;
  const promptText = `${selectedText}\n\n${reference}`;

  return {
    ...clampSelectionMenuPosition(rect),
    text: selectedText,
    promptText,
    reference,
  };
}

function ProjectPreviewSelectionOverlay({
  rootRef,
  preview,
  path,
  projectRoot,
  label,
  onAppend,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  preview: FilePreviewResponse | null;
  path: string;
  projectRoot?: string | null;
  label: string;
  onAppend: (text: string) => void;
}) {
  const [selectionMenu, setSelectionMenu] =
    useState<ProjectPreviewSelectionMenu | null>(null);
  const selectionTimeoutRef = useRef<number | null>(null);

  const clearSelectionTimer = useCallback(() => {
    if (selectionTimeoutRef.current !== null) {
      window.clearTimeout(selectionTimeoutRef.current);
      selectionTimeoutRef.current = null;
    }
  }, []);

  const openSelectionMenu = useCallback(
    (fallbackClientX?: number, fallbackClientY?: number) => {
      const root = rootRef.current;
      if (!root) return false;

      const menu = projectPreviewSelectionMenuFromSelection({
        root,
        preview,
        path,
        projectRoot,
        fallbackClientX,
        fallbackClientY,
      });
      setSelectionMenu(menu);
      return Boolean(menu);
    },
    [path, preview, projectRoot, rootRef],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleMouseUp = (event: MouseEvent) => {
      clearSelectionTimer();
      const clientX = event.clientX;
      const clientY = event.clientY;
      selectionTimeoutRef.current = window.setTimeout(() => {
        selectionTimeoutRef.current = null;
        openSelectionMenu(clientX, clientY);
      }, 120);
    };

    const handleContextMenu = (event: MouseEvent) => {
      clearSelectionTimer();
      if (openSelectionMenu(event.clientX, event.clientY)) {
        event.preventDefault();
      }
    };

    root.addEventListener("mouseup", handleMouseUp);
    root.addEventListener("contextmenu", handleContextMenu);
    return () => {
      clearSelectionTimer();
      root.removeEventListener("mouseup", handleMouseUp);
      root.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [clearSelectionTimer, openSelectionMenu, rootRef]);

  useEffect(() => {
    clearSelectionTimer();
    setSelectionMenu(null);
  }, [clearSelectionTimer, path, preview]);

  const handleAppend = useCallback(() => {
    if (!selectionMenu) return;
    onAppend(selectionMenu.promptText);
    setSelectionMenu(null);
  }, [onAppend, selectionMenu]);

  if (!selectionMenu) return null;

  return (
    <div
      className="fixed z-[70] w-[268px] rounded-2xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl"
      style={{ left: selectionMenu.x, top: selectionMenu.y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto min-h-10 w-full justify-start gap-2 rounded-xl px-3 py-2 text-start text-xs"
        onClick={handleAppend}
      >
        <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="block font-medium">{label}</span>
          <span
            className="block truncate font-mono text-[10px] text-muted-foreground"
            dir="ltr"
          >
            {selectionMenu.reference}
          </span>
        </span>
      </Button>
    </div>
  );
}

function findTranscriptRowElement(rowId: string) {
  const rows = document.querySelectorAll<HTMLElement>(
    "[data-transcript-row-id]",
  );
  for (const row of rows) {
    if (row.dataset.transcriptRowId === rowId) {
      return row;
    }
  }
  return null;
}

function getTranscriptTargetElement(messageId: string, rowId: string) {
  return (
    document.getElementById(`msg-${messageId}`) ??
    findTranscriptRowElement(rowId)
  );
}

function highlightTranscriptElement(element: HTMLElement) {
  if (!element) return false;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.add("ring-2", "ring-logo/60", "rounded-2xl");
  window.setTimeout(
    () => element.classList.remove("ring-2", "ring-logo/60", "rounded-2xl"),
    1800,
  );
  return true;
}

const MOBILE_RIGHT_SIDEBAR_BREAKPOINT_PX = 768;
const RIGHT_SIDEBAR_MIN_WORKSPACE_SIZE_PERCENT = 20;
const RIGHT_SIDEBAR_MAX_SIZE_PERCENT =
  100 - RIGHT_SIDEBAR_MIN_WORKSPACE_SIZE_PERCENT;

export function shouldUseMobileRightSidebarOverlay(viewportWidth: number) {
  return (
    viewportWidth > 0 && viewportWidth < MOBILE_RIGHT_SIDEBAR_BREAKPOINT_PX
  );
}

export function getRightSidebarSizePercent(
  sizePx: number,
  layoutWidth: number,
) {
  if (
    !Number.isFinite(sizePx) ||
    !Number.isFinite(layoutWidth) ||
    layoutWidth <= 0
  ) {
    return 0;
  }

  const minSizePercent = (RIGHT_SIDEBAR_MIN_WIDTH_PX / layoutWidth) * 100;
  const requestedSizePercent =
    (Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, sizePx) / layoutWidth) * 100;
  return Math.min(
    RIGHT_SIDEBAR_MAX_SIZE_PERCENT,
    Math.max(minSizePercent, requestedSizePercent),
  );
}

export function getRightSidebarSizePx(
  sizePercent: number,
  layoutWidth: number,
) {
  if (
    !Number.isFinite(sizePercent) ||
    !Number.isFinite(layoutWidth) ||
    layoutWidth <= 0
  ) {
    return DEFAULT_RIGHT_SIDEBAR_SIZE;
  }

  return Math.max(
    RIGHT_SIDEBAR_MIN_WIDTH_PX,
    layoutWidth * (sizePercent / 100),
  );
}

function useMobileRightSidebarOverlayEnabled() {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  return shouldUseMobileRightSidebarOverlay(viewportWidth);
}

function useFixedTerminalHeight(args: {
  layoutRootRef: RefObject<HTMLDivElement | null>;
  shouldRenderTerminalLayout: boolean;
  terminalMainSizes: [number, number];
}) {
  const [fixedTerminalHeight, setFixedTerminalHeight] = useState(0);

  useEffect(() => {
    const element = args.layoutRootRef.current;
    if (!element) return;

    const updateHeight = () => {
      const containerHeight = element.getBoundingClientRect().height;

      if (!args.shouldRenderTerminalLayout) {
        return;
      }

      if (containerHeight <= 0) return;
      const nextHeight = containerHeight * (args.terminalMainSizes[1] / 100);
      if (nextHeight <= 0) return;
      setFixedTerminalHeight((current) =>
        Math.abs(current - nextHeight) < 1 ? current : nextHeight,
      );
    };

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    updateHeight();

    return () => observer.disconnect();
  }, [
    args.layoutRootRef,
    args.shouldRenderTerminalLayout,
    args.terminalMainSizes,
  ]);

  return fixedTerminalHeight;
}

interface ChatWorkspaceProps {
  chatCard: ReactNode;
  projectId: string;
  shouldRenderTerminalLayout: boolean;
  showTerminalPane: boolean;
  terminalLayout: ReturnType<
    typeof useTerminalLayoutStore.getState
  >["projects"][string];
  mainPanelGroupRef: RefObject<GroupImperativeHandle | null>;
  terminalPanelRef: RefObject<HTMLDivElement | null>;
  terminalVisualRef: RefObject<HTMLDivElement | null>;
  fixedTerminalHeight: number;
  terminalFocusRequestVersion: number;
  addTerminal: ReturnType<
    typeof useTerminalLayoutStore.getState
  >["addTerminal"];
  socket: AbolqasemState["socket"];
  connectionStatus: AbolqasemState["connectionStatus"];
  scrollback: number;
  minColumnWidth: number;
  splitTerminalShortcut?: string[];
  pendingCommandsByTerminalId?: Record<string, string>;
  onTerminalCommandSent?: () => void;
  onInitialTerminalCommandSent?: (terminalId: string) => void;
  onRemoveTerminal: (projectId: string, terminalId: string) => void;
  onTerminalLayout: ReturnType<
    typeof useTerminalLayoutStore.getState
  >["setTerminalSizes"];
  onLayoutChanged: (layout: Record<string, number>) => void;
}

type ChatSidebarContentProps = ComponentProps<typeof GitPanel>;

const ChatSidebarContent = memo(function ChatSidebarContent(
  props: ChatSidebarContentProps,
) {
  return (
    <Suspense fallback={<PaneLoading />}>
      <LazyGitPanel {...props} diffs={props.diffs ?? EMPTY_DIFF_SNAPSHOT} />
    </Suspense>
  );
});

function PaneLoading() {
  return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
}

export function getTerminalPanelDefaultSizes(
  showTerminalPane: boolean,
  mainSizes: [number, number],
): [number, number] {
  return showTerminalPane ? mainSizes : [100, 0];
}

interface DesktopSidebarPaneProps {
  showRightSidebar: boolean;
  sizePercent: number;
  direction: RightSidebarLayoutDirection;
  sidebarPanelRef: RefObject<HTMLDivElement | null>;
  sidebarVisualRef: RefObject<HTMLDivElement | null>;
  content: ReactNode;
}

const DesktopSidebarPane = memo(function DesktopSidebarPane({
  showRightSidebar,
  sizePercent,
  direction,
  sidebarPanelRef,
  sidebarVisualRef,
  content,
}: DesktopSidebarPaneProps) {
  return (
    <ResizablePanel
      id="rightSidebar"
      defaultSize={sizePercent}
      minSize={0}
      maxSize={showRightSidebar ? undefined : 0}
      collapsible
      collapsedSize={0}
      className="min-h-0 min-w-0"
      elementRef={sidebarPanelRef}
      groupResizeBehavior="preserve-pixel-size"
    >
      <div
        ref={sidebarVisualRef}
        dir={direction}
        className="h-full min-h-0 overflow-hidden"
        data-right-sidebar-open={showRightSidebar ? "true" : "false"}
        data-right-sidebar-animated="false"
        data-right-sidebar-visual
        style={
          {
            "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
          } as CSSProperties
        }
      >
        {content}
      </div>
    </ResizablePanel>
  );
});

interface MobileSidebarPaneProps {
  projectId: string | null;
  showRightSidebar: boolean;
  isRtl: boolean;
  sidebarVisualRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  content: ReactNode;
}

const MobileSidebarPane = memo(function MobileSidebarPane({
  projectId,
  showRightSidebar,
  isRtl,
  sidebarVisualRef,
  onClose,
  content,
}: MobileSidebarPaneProps) {
  if (!projectId) {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute inset-0 z-40 transition-opacity duration-300 ease-out",
        showRightSidebar
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0",
      )}
      aria-hidden={showRightSidebar ? undefined : true}
      data-mobile-right-sidebar-overlay
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        aria-label="Close changes sidebar"
        onClick={onClose}
      />
      <div
        ref={sidebarVisualRef}
        className={cn(
          "absolute inset-y-0 flex w-[min(92vw,30rem)] max-w-full min-h-0 flex-col overflow-hidden bg-background shadow-2xl transition-transform duration-300 ease-out",
          isRtl
            ? "left-0 border-r border-border"
            : "right-0 border-l border-border",
          "pt-[max(env(safe-area-inset-top),0px)] pb-[max(env(safe-area-inset-bottom),0px)]",
          showRightSidebar
            ? "translate-x-0"
            : isRtl
              ? "-translate-x-full"
              : "translate-x-full",
        )}
        data-right-sidebar-open={showRightSidebar ? "true" : "false"}
        data-right-sidebar-animated="false"
        data-right-sidebar-visual
      >
        {content}
      </div>
    </div>
  );
});

function ChatWorkspace({
  chatCard,
  projectId,
  shouldRenderTerminalLayout,
  showTerminalPane,
  terminalLayout,
  mainPanelGroupRef,
  terminalPanelRef,
  terminalVisualRef,
  fixedTerminalHeight,
  terminalFocusRequestVersion,
  addTerminal,
  socket,
  connectionStatus,
  scrollback,
  minColumnWidth,
  splitTerminalShortcut,
  pendingCommandsByTerminalId,
  onTerminalCommandSent,
  onInitialTerminalCommandSent,
  onRemoveTerminal,
  onTerminalLayout,
  onLayoutChanged,
}: ChatWorkspaceProps) {
  if (!shouldRenderTerminalLayout) {
    return <>{chatCard}</>;
  }

  const terminalPanelDefaultSizes = getTerminalPanelDefaultSizes(
    showTerminalPane,
    terminalLayout.mainSizes,
  );

  return (
    <ResizablePanelGroup
      key={projectId}
      groupRef={mainPanelGroupRef}
      orientation="vertical"
      className="flex-1 min-h-0"
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="chat"
        defaultSize={`${terminalPanelDefaultSizes[0]}%`}
        minSize="25%"
        className="min-h-0"
      >
        {chatCard}
      </ResizablePanel>
      <ResizableHandle
        withHandle
        orientation="vertical"
        disabled={!showTerminalPane}
        className={cn(!showTerminalPane && "pointer-events-none opacity-0")}
      />
      <ResizablePanel
        id="terminal"
        defaultSize={`${terminalPanelDefaultSizes[1]}%`}
        minSize="0%"
        className="min-h-0"
        elementRef={terminalPanelRef}
      >
        <div
          ref={terminalVisualRef}
          className="h-full min-h-0 overflow-hidden relative"
          data-terminal-open={showTerminalPane ? "true" : "false"}
          data-terminal-animated="false"
          data-terminal-visual
          style={
            {
              "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
            } as CSSProperties
          }
        >
          {showTerminalPane ? (
            <Suspense fallback={<PaneLoading />}>
              <LazyTerminalWorkspaceShell
                projectId={projectId}
                fixedTerminalHeight={fixedTerminalHeight}
                terminalLayout={terminalLayout}
                addTerminal={addTerminal}
                socket={socket}
                connectionStatus={connectionStatus}
                scrollback={scrollback}
                minColumnWidth={minColumnWidth}
                splitTerminalShortcut={splitTerminalShortcut}
                pendingCommandsByTerminalId={pendingCommandsByTerminalId}
                focusRequestVersion={terminalFocusRequestVersion}
                onTerminalCommandSent={onTerminalCommandSent}
                onInitialTerminalCommandSent={onInitialTerminalCommandSent}
                onRemoveTerminal={onRemoveTerminal}
                onTerminalLayout={onTerminalLayout}
              />
            </Suspense>
          ) : null}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function ChatPage() {
  const { t, direction, locale } = useI18n();
  const isRtl = direction === "rtl";
  const [appearanceSettings] = useReaderAppearanceSettings();
  const state = useOutletContext<AbolqasemState>();
  const dialog = useAppDialog();
  const layoutRootRef = useRef<HTMLDivElement>(null);
  const transcriptListRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(true);
  const showScrollTimeoutRef = useRef<number | null>(null);
  const transcriptNavigationGenerationRef = useRef(0);
  const transcriptNavigationRequestIdRef = useRef(0);
  const chatCardRef = useRef<HTMLDivElement>(null);
  const chatInputElementRef = useRef<HTMLTextAreaElement>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const messagesRef = useRef(state.messages);
  const previousMessageCountRef = useRef(state.messages.length);
  const previousLastMessageIdRef = useRef(state.messages.at(-1)?.id ?? null);
  const latestToolIdsRef = useRef(state.latestToolIds);
  const hasOlderHistoryRef = useRef(state.hasOlderHistory);
  const loadOlderHistoryRef = useRef(state.loadOlderHistory);
  const lastUserPromptJumpIdRef = useRef<string | null>(null);
  const lastShiftKeydownRef = useRef(0);
  const { inputRef, syncInputHeight, transcriptPaddingBottom } =
    useTranscriptPaddingBottom();
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);
  const [pendingTerminalCommands, setPendingTerminalCommands] = useState<
    Record<string, string>
  >({});
  const [filesPanelFocusToken, setFilesPanelFocusToken] = useState(0);
  const [projectFilePreviewTarget, setProjectFilePreviewTarget] =
    useState<ProjectFilePreviewTarget | null>(null);
  const [projectFilePreview, setProjectFilePreview] =
    useState<FilePreviewResponse | null>(null);
  const [projectFilePreviewLoading, setProjectFilePreviewLoading] =
    useState(false);
  const [projectFilePreviewError, setProjectFilePreviewError] = useState<
    string | null
  >(null);
  const [codexLockActionPending, setCodexLockActionPending] = useState(false);
  const projectPreviewRootRef = useRef<HTMLDivElement | null>(null);
  const showEmptyState =
    state.messages.length === 0 && state.runtime?.title === "New Chat";
  const transcriptTailVersion = useMemo(
    () => getTranscriptTailVersion(state.messages),
    [state.messages],
  );
  const projectId = state.activeProjectId;
  const codexLock = state.runtime?.codexLock;
  const codexChatReadOnly =
    state.runtime?.readOnly === true ||
    codexLock?.state === "owned_elsewhere" ||
    codexLock?.state === "unknown";
  const projectTerminalLayout = useTerminalLayoutStore((store) =>
    projectId ? store.projects[projectId] : undefined,
  );
  const terminalLayout =
    projectTerminalLayout ?? DEFAULT_PROJECT_TERMINAL_LAYOUT;
  const projectRightSidebarVisibility = useRightSidebarStore((store) =>
    projectId ? store.projects[projectId] : undefined,
  );
  const rightSidebarVisibility =
    projectRightSidebarVisibility ?? DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE;
  const globalRightSidebarSize = useRightSidebarStore((store) => store.size);
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal);
  const removeTerminal = useTerminalLayoutStore(
    (store) => store.removeTerminal,
  );
  const toggleVisibility = useTerminalLayoutStore(
    (store) => store.toggleVisibility,
  );
  const resetMainSizes = useTerminalLayoutStore(
    (store) => store.resetMainSizes,
  );
  const setMainSizes = useTerminalLayoutStore((store) => store.setMainSizes);
  const setTerminalSizes = useTerminalLayoutStore(
    (store) => store.setTerminalSizes,
  );
  const toggleRightPanel = useRightSidebarStore((store) => store.togglePanel);
  const hideRightPanel = useRightSidebarStore((store) => store.hidePanel);
  const setRightSidebarSize = useRightSidebarStore((store) => store.setSize);
  const scrollback = useTerminalPreferencesStore(
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
  const resolvedKeybindings = useMemo(
    () => getResolvedKeybindings(state.keybindings),
    [state.keybindings],
  );
  const baseContextWindowSnapshotRef =
    useRef<ReturnType<typeof deriveLatestContextWindowSnapshot>>(null);
  const [cachedUsageSnapshot, setCachedUsageSnapshot] =
    useState<UsageSnapshot["codex"]>(null);
  const contextWindowSnapshot = useMemo(() => {
    const derivedSnapshot = deriveLatestContextWindowSnapshot(
      state.chatSnapshot?.messages ?? [],
    );
    const previousSnapshot = baseContextWindowSnapshotRef.current;
    if (sameContextWindowSnapshot(previousSnapshot, derivedSnapshot)) {
      return previousSnapshot;
    }
    baseContextWindowSnapshotRef.current = derivedSnapshot;
    return derivedSnapshot;
  }, [state.chatSnapshot?.messages]);
  const transcriptRateLimitSnapshot = useMemo(
    () => deriveLatestRateLimitSnapshot(state.chatSnapshot?.messages ?? []),
    [state.chatSnapshot?.messages],
  );
  // A transcript snapshot is historical. Prefer the independently refreshed
  // account snapshot so a limit hit or an account switch becomes visible even
  // when the current transcript has no newer rate_limit_updated event.
  const rateLimitSnapshot =
    cachedUsageSnapshot?.rate_limits ?? transcriptRateLimitSnapshot ?? null;
  const transcriptAccountEmail = useMemo(() => {
    const entries = state.chatSnapshot?.messages ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind === "account_info" && entry.accountInfo.email)
        return entry.accountInfo.email;
    }
    return null;
  }, [state.chatSnapshot?.messages]);
  const accountEmail =
    cachedUsageSnapshot?.account?.email ?? transcriptAccountEmail;
  const codexSessionId =
    state.runtime?.nativeSessionId ??
    codexLock?.sessionId ??
    state.runtime?.sessionToken ??
    state.runtime?.pendingForkSessionToken ??
    null;
  const codexSessionPath =
    state.runtime?.nativeTranscriptPath ?? codexLock?.sessionPath ?? null;

  const fetchUsageSnapshot = useCallback(
    async (method: "GET" | "POST", signal?: AbortSignal) => {
      const response = await fetch(
        method === "POST" ? "/api/usage/refresh" : "/api/usage",
        {
          method,
          cache: "no-store",
          signal,
        },
      );
      if (!response.ok) return null;
      const snapshot = (await response.json()) as UsageSnapshot;
      setCachedUsageSnapshot(snapshot.codex);
      return snapshot;
    },
    [],
  );

  const refreshUsageAfterAccountActivation = useCallback(async () => {
    setCachedUsageSnapshot(null);
    const snapshot = await fetchUsageSnapshot("POST");
    if (!snapshot?.codex) {
      throw new Error("Could not load usage for the activated account");
    }
  }, [fetchUsageSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchUsageSnapshot("GET", controller.signal)
      .then((snapshot) =>
        snapshot?.codex?.account
          ? null
          : fetchUsageSnapshot("POST", controller.signal),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, [fetchUsageSnapshot, state.activeChatId]);
  useLayoutEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  useEffect(() => {
    const nextLastMessageId = state.messages.at(-1)?.id ?? null;
    if (
      shouldShowTranscriptUnreadIndicator(
        previousMessageCountRef.current,
        previousLastMessageIdRef.current,
        state.messages,
        isAtEndRef.current,
      )
    ) {
      setHasUnreadMessages(true);
    }
    if (isAtEndRef.current) {
      setHasUnreadMessages(false);
    }

    previousMessageCountRef.current = state.messages.length;
    previousLastMessageIdRef.current = nextLastMessageId;
  }, [state.messages]);

  useLayoutEffect(() => {
    latestToolIdsRef.current = state.latestToolIds;
  }, [state.latestToolIds]);

  useLayoutEffect(() => {
    hasOlderHistoryRef.current = state.hasOlderHistory;
  }, [state.hasOlderHistory]);

  useLayoutEffect(() => {
    loadOlderHistoryRef.current = state.loadOlderHistory;
  }, [state.loadOlderHistory]);

  const hasTerminals = terminalLayout.terminals.length > 0;
  const showTerminalPane = Boolean(
    projectId && terminalLayout.isVisible && hasTerminals,
  );
  const shouldRenderTerminalLayout = Boolean(projectId && hasTerminals);
  const activeRightPanel = projectId
    ? rightSidebarVisibility.rightPanel
    : "hidden";
  const showRightSidebar = Boolean(projectId && activeRightPanel !== "hidden");
  const showGitPanel = Boolean(projectId && activeRightPanel === "git");
  const shouldRenderRightSidebarLayout = Boolean(projectId);
  const isMobileRightSidebarOverlay = useMobileRightSidebarOverlayEnabled();
  const shouldRenderDesktopRightSidebarLayout =
    shouldRenderRightSidebarLayout && !isMobileRightSidebarOverlay;
  const layoutWidth = useLayoutWidth(layoutRootRef);
  const effectiveRightSidebarSize = getRightSidebarSizePercent(
    globalRightSidebarSize ?? DEFAULT_RIGHT_SIDEBAR_SIZE,
    layoutWidth,
  );
  const fixedTerminalHeight = useFixedTerminalHeight({
    layoutRootRef,
    shouldRenderTerminalLayout,
    terminalMainSizes: terminalLayout.mainSizes,
  });

  const {
    isAnimating: isTerminalAnimating,
    mainPanelGroupRef,
    terminalFocusRequestVersion,
    terminalPanelRef,
    terminalVisualRef,
  } = useTerminalToggleAnimation({
    showTerminalPane,
    shouldRenderTerminalLayout,
    projectId,
    terminalLayout,
    chatInputRef: chatInputElementRef,
  });
  const {
    isAnimating: isRightSidebarAnimating,
    panelGroupRef: rightSidebarPanelGroupRef,
    sidebarPanelRef,
    sidebarVisualRef,
  } = useRightSidebarToggleAnimation({
    projectId,
    shouldRenderRightSidebarLayout: shouldRenderDesktopRightSidebarLayout,
    showRightSidebar,
    rightSidebarSizePercent: effectiveRightSidebarSize,
    direction,
  });

  const {
    diffRenderMode,
    wrapDiffLines,
    setDiffRenderMode,
    setWrapDiffLines,
    scheduleTerminalDiffRefresh,
    handleOpenDiffFile,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleLoadDiffPatch,
    handleDiscardDiffFile,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleOpenDiffInFinder,
    handleCommitDiffs,
    handleSyncBranch,
    handleGenerateCommitMessage,
    handleInitializeGit,
    handleGetGitHubPublishInfo,
    handleCheckGitHubRepoAvailability,
    handleSetupGitHub,
    handleListBranches,
    handleCheckoutBranch,
    handlePreviewMergeBranch,
    handleMergeBranch,
    handleCreateBranch,
  } = useChatPageSidebarActions({
    state,
    projectId,
    showRightSidebar: showGitPanel,
  });

  const { typedEmptyStateText, isEmptyStateTypingComplete } =
    useEmptyStateTyping(showEmptyState, state.activeChatId, t.chat.emptyState);

  useStickyChatFocus({
    rootRef: chatCardRef,
    fallbackRef: chatInputElementRef,
    enabled: state.hasSelectedProject,
    canCancel: state.canCancel,
  });

  const enqueueDroppedFiles = useCallback(
    (files: File[]) => {
      if (!state.hasSelectedProject || files.length === 0) {
        return;
      }
      chatInputRef.current?.enqueueFiles(files);
    },
    [state.hasSelectedProject],
  );

  const {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  } = usePageFileDrop({
    hasSelectedProject: state.hasSelectedProject,
    onFilesDropped: enqueueDroppedFiles,
  });

  useEffect(() => {
    setProjectFilePreviewTarget(null);
    setProjectFilePreview(null);
    setProjectFilePreviewError(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !projectFilePreviewTarget) {
      setProjectFilePreview(null);
      setProjectFilePreviewError(null);
      setProjectFilePreviewLoading(false);
      return;
    }

    const controller = new AbortController();
    setProjectFilePreviewLoading(true);
    setProjectFilePreviewError(null);

    readProjectFilePreview(projectId, projectFilePreviewTarget.path, {
      signal: controller.signal,
    })
      .then(setProjectFilePreview)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setProjectFilePreview(null);
        setProjectFilePreviewError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectFilePreviewLoading(false);
      });

    return () => controller.abort();
  }, [projectFilePreviewTarget, projectId]);

  const handleSelectProjectFile = useCallback((entry: ProjectFileEntry) => {
    if (entry.type !== "file") return;
    setProjectFilePreviewTarget({ path: entry.path, name: entry.name });
  }, []);

  const handleCloseProjectFilePreview = useCallback(() => {
    setProjectFilePreviewTarget(null);
    setProjectFilePreview(null);
    setProjectFilePreviewError(null);
  }, []);

  const appendTextToComposer = useCallback((text: string) => {
    if (!text.trim()) return;
    chatInputRef.current?.appendText(text);
  }, []);

  const handleToggleEmbeddedTerminal = useCallback(() => {
    if (!projectId) return;
    if (hasTerminals) {
      toggleVisibility(projectId);
      return;
    }

    addTerminal(projectId);
  }, [addTerminal, hasTerminals, projectId, toggleVisibility]);

  const handleTerminalResize = useCallback(
    (layout: Record<string, number>) => {
      if (!projectId || !showTerminalPane || isTerminalAnimating.current) {
        return;
      }

      const chatSize = layout.chat;
      const terminalSize = layout.terminal;
      if (!Number.isFinite(chatSize) || !Number.isFinite(terminalSize)) {
        return;
      }

      const containerHeight =
        layoutRootRef.current?.getBoundingClientRect().height ?? 0;
      if (shouldCloseTerminalPane(containerHeight, terminalSize)) {
        resetMainSizes(projectId);
        toggleVisibility(projectId);
        return;
      }

      setMainSizes(projectId, [chatSize, terminalSize]);
    },
    [
      isTerminalAnimating,
      projectId,
      resetMainSizes,
      setMainSizes,
      showTerminalPane,
      toggleVisibility,
    ],
  );

  const handleCloseRightSidebar = useCallback(() => {
    if (!projectId) return;
    hideRightPanel(projectId);
  }, [hideRightPanel, projectId]);

  const handleToggleGitPanel = useCallback(() => {
    if (!projectId) return;

    if (activeRightPanel === "git") {
      hideRightPanel(projectId);
      return;
    }

    if (state.chatDiffSnapshot?.status === "no_repo") {
      void (async () => {
        const confirmed = await dialog.confirm({
          title: t.chat.initializeGit,
          description: t.chat.initializeGitDescription,
          confirmLabel: t.chat.initGit,
          cancelLabel: t.common.cancel,
        });
        if (!confirmed) return;

        const result = await handleInitializeGit();
        if (result?.ok) {
          toggleRightPanel(projectId, "git");
        }
      })();
      return;
    }

    toggleRightPanel(projectId, "git");
  }, [
    activeRightPanel,
    dialog,
    handleInitializeGit,
    hideRightPanel,
    projectId,
    state.chatDiffSnapshot?.status,
    t,
    toggleRightPanel,
  ]);

  const handleToggleBrowserPanel = useCallback(() => {
    if (!projectId) return;
    toggleRightPanel(projectId, "browser");
  }, [projectId, toggleRightPanel]);

  const handleToggleFilesPanel = useCallback(() => {
    if (!projectId) return;
    toggleRightPanel(projectId, "files");
  }, [projectId, toggleRightPanel]);

  const handleOpenFilesSearch = useCallback(() => {
    if (!projectId) return;
    if (activeRightPanel !== "files") {
      toggleRightPanel(projectId, "files");
    }
    setFilesPanelFocusToken((current) => current + 1);
  }, [activeRightPanel, projectId, toggleRightPanel]);

  const handleRunQuickAction = useCallback(
    (command: string) => {
      if (!projectId) return;
      const terminalId = addTerminal(projectId);
      setPendingTerminalCommands((current) => ({
        ...current,
        [terminalId]: command,
      }));
    },
    [addTerminal, projectId],
  );

  const handleInitialTerminalCommandSent = useCallback((terminalId: string) => {
    setPendingTerminalCommands((current) => {
      if (!(terminalId in current)) return current;
      const { [terminalId]: _sent, ...rest } = current;
      return rest;
    });
  }, []);

  const handleCancel = useCallback(() => {
    void state.handleCancel();
  }, [state.handleCancel]);

  const handleOpenExternal = useCallback<
    NonNullable<ComponentProps<typeof ChatNavbar>["onOpenExternal"]>
  >(
    (action, editor) => {
      void state.handleOpenExternal(action, editor);
    },
    [state.handleOpenExternal],
  );

  const handleRemoveTerminal = useCallback(
    (currentProjectId: string, terminalId: string) => {
      void state.socket
        .command({ type: "terminal.close", terminalId })
        .catch(() => {});
      removeTerminal(currentProjectId, terminalId);
    },
    [removeTerminal, state.socket],
  );

  const clearShowScrollTimeout = useCallback(() => {
    if (showScrollTimeoutRef.current !== null) {
      window.clearTimeout(showScrollTimeoutRef.current);
      showScrollTimeoutRef.current = null;
    }
  }, []);

  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (isAtEndRef.current === isAtEnd) return;
      isAtEndRef.current = isAtEnd;
      if (isAtEnd) {
        clearShowScrollTimeout();
        setShowScrollToBottom(false);
        setHasUnreadMessages(false);
        return;
      }

      clearShowScrollTimeout();
      showScrollTimeoutRef.current = window.setTimeout(() => {
        setShowScrollToBottom(true);
        showScrollTimeoutRef.current = null;
      }, 150);
    },
    [clearShowScrollTimeout],
  );

  const syncIsAtEndFromList = useCallback(() => {
    const state = transcriptListRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [onIsAtEndChange]);

  const scrollToTranscriptEnd = useCallback(
    async (animated = true) => {
      isAtEndRef.current = true;
      clearShowScrollTimeout();
      setShowScrollToBottom(false);
      setHasUnreadMessages(false);
      await transcriptListRef.current?.scrollToEnd?.({ animated });
    },
    [clearShowScrollTimeout],
  );

  const waitForTranscriptUpdate = useCallback(
    async (
      previousMessages: AbolqasemState["messages"],
      isReady: () => boolean,
    ) => {
      for (let frame = 0; frame < 30; frame += 1) {
        await waitForNextFrame();
        if (
          isReady() ||
          messagesRef.current !== previousMessages ||
          messagesRef.current.length !== previousMessages.length
        ) {
          return true;
        }
      }
      return false;
    },
    [],
  );

  const loadOlderHistoryUntil = useCallback(
    async (
      resolveTarget: () => TranscriptRowTarget | null,
      options?: {
        generation?: number;
        requestId?: number;
        maxAttempts?: number;
      },
    ) => {
      const generation =
        options?.generation ?? transcriptNavigationGenerationRef.current;
      const requestId =
        options?.requestId ?? transcriptNavigationRequestIdRef.current;
      const maxAttempts = options?.maxAttempts ?? 30;
      let target = resolveTarget();
      let attempts = 0;

      while (!target && hasOlderHistoryRef.current && attempts < maxAttempts) {
        if (
          generation !== transcriptNavigationGenerationRef.current ||
          requestId !== transcriptNavigationRequestIdRef.current
        ) {
          return null;
        }
        const previousMessages = messagesRef.current;
        await loadOlderHistoryRef.current();
        if (
          generation !== transcriptNavigationGenerationRef.current ||
          requestId !== transcriptNavigationRequestIdRef.current
        ) {
          return null;
        }
        const changed = await waitForTranscriptUpdate(previousMessages, () =>
          Boolean(resolveTarget()),
        );
        target = resolveTarget();
        attempts += 1;

        if (!target && !changed && messagesRef.current === previousMessages) {
          break;
        }
      }

      return target;
    },
    [waitForTranscriptUpdate],
  );

  const resolveTranscriptTargetByIds = useCallback(
    (ids: Array<string | null | undefined>) => {
      for (const rawId of ids) {
        const id = rawId?.trim();
        if (!id) {
          continue;
        }
        const loadedMessage = findLoadedTranscriptMessageById(
          messagesRef.current,
          id,
        );
        if (!loadedMessage) {
          continue;
        }
        const target = findTranscriptRowTarget(
          messagesRef.current,
          latestToolIdsRef.current,
          loadedMessage,
        );
        if (target) {
          return target;
        }
      }
      return null;
    },
    [],
  );

  const loadTranscriptTargetByIds = useCallback(
    async (ids: Array<string | null | undefined>, maxAttempts?: number) => {
      const requestId = ++transcriptNavigationRequestIdRef.current;
      const generation = transcriptNavigationGenerationRef.current;
      const loadedTarget = resolveTranscriptTargetByIds(ids);
      if (loadedTarget) {
        return loadedTarget;
      }

      const targetCursor = ids.map((id) => id?.trim()).find(Boolean);
      if (targetCursor) {
        const previousMessages = messagesRef.current;
        const loadedAroundTarget = await state.loadHistoryAround(
          targetCursor,
          120,
        );
        if (
          generation !== transcriptNavigationGenerationRef.current ||
          requestId !== transcriptNavigationRequestIdRef.current
        ) {
          return null;
        }
        if (loadedAroundTarget) {
          await waitForTranscriptUpdate(previousMessages, () =>
            Boolean(resolveTranscriptTargetByIds(ids)),
          );
          const directTarget = resolveTranscriptTargetByIds(ids);
          if (directTarget) {
            return directTarget;
          }
        }
      }

      return loadOlderHistoryUntil(() => resolveTranscriptTargetByIds(ids), {
        generation,
        requestId,
        maxAttempts,
      });
    },
    [
      loadOlderHistoryUntil,
      resolveTranscriptTargetByIds,
      state.loadHistoryAround,
      waitForTranscriptUpdate,
    ],
  );

  const scrollToResolvedTranscriptTarget = useCallback(
    async (target: TranscriptRowTarget) => {
      const highlightTarget = () => {
        const element = getTranscriptTargetElement(
          target.message.id,
          target.row.id,
        );
        return element ? highlightTranscriptElement(element) : false;
      };

      if (highlightTarget()) {
        return true;
      }

      try {
        await transcriptListRef.current?.scrollToIndex?.({
          index: target.rowIndex,
          viewPosition: 0.5,
          animated: true,
        });
      } catch {
        // LegendList can reject if the row is no longer in the current virtualized data.
      }

      for (let frame = 0; frame < 12; frame += 1) {
        await waitForNextFrame();
        if (highlightTarget()) {
          return true;
        }
      }

      return false;
    },
    [],
  );

  const handleMinimapScrollToMessage = useCallback(
    async (item: MessageIndexItem) => {
      const target = resolveTranscriptTargetByIds([item.id]);
      if (!target || !(await scrollToResolvedTranscriptTarget(target))) {
        throw new Error("Unable to scroll to the transcript message.");
      }
    },
    [resolveTranscriptTargetByIds, scrollToResolvedTranscriptTarget],
  );

  const handleChatSearchResultSelect = useCallback(
    async (match: ChatSearchMatch) => {
      const target = await loadTranscriptTargetByIds(
        [match.entry_id, match.message_id],
        40,
      );
      if (target && (await scrollToResolvedTranscriptTarget(target))) {
        return;
      }

      await dialog.alert({
        title: "نتیجه قابل نمایش نیست",
        description:
          "نتیجه در transcript پیدا شد، اما در پیام‌های قابل نمایش این نشست پیدا نشد.",
        closeLabel: t.common.ok,
      });
    },
    [dialog, loadTranscriptTargetByIds, scrollToResolvedTranscriptTarget, t],
  );

  const handleJumpToPreviousUserPrompt = useCallback(async () => {
    const getTarget = () => {
      const message = findPreviousUserPromptMessage(
        messagesRef.current,
        lastUserPromptJumpIdRef.current,
      );
      if (!message) return null;
      return findTranscriptRowTarget(
        messagesRef.current,
        latestToolIdsRef.current,
        message,
      );
    };

    let target = getTarget();
    if (!target) {
      target = await loadOlderHistoryUntil(getTarget);
    }
    if (!target) {
      return;
    }

    lastUserPromptJumpIdRef.current = target.message.id;
    await scrollToResolvedTranscriptTarget(target);
  }, [loadOlderHistoryUntil, scrollToResolvedTranscriptTarget]);

  const handleChatSubmit = useCallback(
    async (
      content: string,
      options?: Parameters<typeof state.handleSend>[1],
    ) => {
      lastUserPromptJumpIdRef.current = null;
      await scrollToTranscriptEnd(false);
      await state.handleSend(content, options);
      // Sending can consume quota or cause the manager to switch accounts. Do
      // this off the send path: composing must not wait for the quota endpoint.
      void fetchUsageSnapshot("POST").catch(() => undefined);
    },
    [fetchUsageSnapshot, scrollToTranscriptEnd, state],
  );

  const handleRetryFailedTurn = useCallback(async () => {
    if (!state.activeChatId || state.isProcessing || codexChatReadOnly) return;
    await handleChatSubmit(locale === "fa" ? "ادامه بده" : "Continue");
  }, [
    codexChatReadOnly,
    handleChatSubmit,
    locale,
    state.activeChatId,
    state.isProcessing,
  ]);

  const handleEditQueuedMessage = useCallback(
    async (queuedMessageId: string) => {
      const message = state.queuedMessages.find(
        (queued) => queued.id === queuedMessageId,
      );
      const composer = chatInputRef.current;
      if (!message || !composer) return;
      if (composer.hasUnsavedDraft()) {
        const confirmed = await dialog.confirm({
          title: "Replace current draft?",
          description:
            "The queued message will be moved into the composer for editing.",
          confirmLabel: "Replace",
          cancelLabel: t.common.cancel,
        });
        if (!confirmed) return;
      }
      await state.handleRemoveQueuedMessage(queuedMessageId);
      composer.hydrateDraft(message.content, message.attachments);
    },
    [
      dialog,
      state.handleRemoveQueuedMessage,
      state.queuedMessages,
      t.common.cancel,
    ],
  );

  const handleRemoveAllQueuedMessages = useCallback(async () => {
    const queuedMessageIds = state.queuedMessages.map((message) => message.id);
    if (queuedMessageIds.length === 0) return;
    const confirmed = await dialog.confirm({
      title: "حذف پیام‌های متوقف‌شده؟",
      description: `${queuedMessageIds.length} پیام در صف این نشست باقی مانده است. این کار آن‌ها را حذف می‌کند و قابل بازگردانی نیست.`,
      confirmLabel: "حذف همه",
      cancelLabel: t.common.cancel,
      confirmVariant: "destructive",
      dir: "rtl",
    });
    if (!confirmed) return;
    for (const queuedMessageId of queuedMessageIds) {
      await state.handleRemoveQueuedMessage(queuedMessageId);
    }
  }, [
    dialog,
    state.handleRemoveQueuedMessage,
    state.queuedMessages,
    t.common.cancel,
  ]);

  const refreshCodexLock = useCallback(async () => {
    if (!state.activeChatId) return;
    setCodexLockActionPending(true);
    try {
      // This deliberately uses the local HTTP snapshot endpoint rather than
      // the WebSocket. Refreshing transcript text must work while the socket
      // is reconnecting and must never depend on the Codex app-server.
      await state.refreshChatTranscript();
    } catch {
      // This is an opportunistic, local-only refresh. Connection recovery owns
      // its own status; an unobtrusive retry is better than interrupting a
      // locked composer with a modal error.
    } finally {
      setCodexLockActionPending(false);
    }
  }, [state.activeChatId, state.refreshChatTranscript]);

  const releaseCodexLock = useCallback(async () => {
    if (!state.activeChatId) return;
    const confirmed = await dialog.confirm({
      title: "آزاد کردن نشست Codex؟",
      description:
        "Abolqasem از app-server این نشست خارج می‌شود. پس از آن، Codex دیگری می‌تواند آن را باز کند.",
      confirmLabel: "آزاد کن",
      cancelLabel: t.common.cancel,
      confirmVariant: "secondary",
      dir: "rtl",
    });
    if (!confirmed) return;
    setCodexLockActionPending(true);
    try {
      await state.socket.command({
        type: "chat.releaseCodexSession",
        chatId: state.activeChatId,
      });
    } catch (error) {
      await dialog.alert({
        title: "نشست آزاد نشد",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t.common.ok,
        dir: "rtl",
      });
    } finally {
      setCodexLockActionPending(false);
    }
  }, [dialog, state.activeChatId, state.socket, t.common.cancel, t.common.ok]);

  const takeOverCodexLock = useCallback(
    async (executionMode: CodexExecutionMode) => {
      if (!state.activeChatId || !codexLock) return;
      const extraWarning = codexLock.otherWritableSessions
        ? ` این process روی ${codexLock.otherWritableSessions} نشست دیگر هم writer دارد و ممکن است آن‌ها نیز قطع شوند.`
        : "";
      const confirmed = await dialog.confirm({
        title: "گرفتن نشست Codex؟",
        description: `process مالک (PID ${codexLock.ownerPid ?? "نامشخص"}) ابتدا با SIGTERM و فقط در صورت باقی‌ماندن writer با SIGKILL متوقف می‌شود؛ سپس Abolqasem نشست را claim می‌کند.${extraWarning}`,
        confirmLabel: "گرفتن نشست",
        cancelLabel: t.common.cancel,
        confirmVariant: "destructive",
        dir: "rtl",
      });
      if (!confirmed) return;
      setCodexLockActionPending(true);
      try {
        await state.socket.command({
          type: "chat.takeOverCodexSession",
          chatId: state.activeChatId,
          confirm: true,
          executionMode,
        });
      } catch (error) {
        await dialog.alert({
          title: "گرفتن نشست ناموفق بود",
          description: error instanceof Error ? error.message : String(error),
          closeLabel: t.common.ok,
          dir: "rtl",
        });
      } finally {
        setCodexLockActionPending(false);
      }
    },
    [
      codexLock,
      dialog,
      state.activeChatId,
      state.socket,
      t.common.cancel,
      t.common.ok,
    ],
  );

  const changeCodexExecutionMode = useCallback(
    async (executionMode: CodexExecutionMode) => {
      if (!state.activeChatId || codexLock?.state !== "owned_by_us") return;
      setCodexLockActionPending(true);
      try {
        await state.socket.command({
          type: "chat.setCodexExecutionMode",
          chatId: state.activeChatId,
          executionMode,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("does not own the Codex session")) {
          await state.socket
            .command({ type: "chat.refresh", chatId: state.activeChatId })
            .catch(() => undefined);
          return;
        }
        await dialog.alert({
          title: "حالت اجرای Codex تغییر نکرد",
          description: message,
          closeLabel: t.common.ok,
          dir: "rtl",
        });
      } finally {
        setCodexLockActionPending(false);
      }
    },
    [codexLock?.state, dialog, state.activeChatId, state.socket, t.common.ok],
  );

  const changeRuntimePlanMode = useCallback(
    async (planMode: boolean) => {
      if (!state.activeChatId) return;
      try {
        await state.socket.command({
          type: "chat.setPlanMode",
          chatId: state.activeChatId,
          planMode,
        });
      } catch (error) {
        await dialog.alert({
          title: "حالت برنامه‌ریزی تغییر نکرد",
          description: error instanceof Error ? error.message : String(error),
          closeLabel: t.common.ok,
          dir: "rtl",
        });
        throw error;
      }
    },
    [dialog, state.activeChatId, state.socket, t.common.ok],
  );

  const changeRuntimePreference = useCallback(
    async (preference: { provider: AgentProvider; model: string }) => {
      // Persist the selected runtime model as the provider's manual default so a
      // full page reload cannot silently restore the catalog's automatic model.
      await state.handleWriteAppSettings({
        providerDefaults: {
          [preference.provider]: {
            model: preference.model,
            modelMode: "manual",
          },
        },
      });
    },
    [state.handleWriteAppSettings],
  );

  const reloadCodexAuth = useCallback(async () => {
    if (!state.activeChatId) return;
    setCodexLockActionPending(true);
    try {
      await state.socket.command({
        type: "chat.reloadCodexAuth",
        chatId: state.activeChatId,
      });
      // Usage refresh is independent of the auth reset. Do not block the
      // button on a slow quota endpoint; it can update the usage panel when it
      // completes in the background.
      void fetchUsageSnapshot("POST").catch(() => undefined);
    } catch (error) {
      await dialog.alert({
        title: "حساب Codex بارگذاری نشد",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t.common.ok,
        dir: "rtl",
      });
    } finally {
      setCodexLockActionPending(false);
    }
  }, [
    dialog,
    fetchUsageSnapshot,
    state.activeChatId,
    state.socket,
    t.common.ok,
  ]);

  useEffect(() => {
    return () => clearShowScrollTimeout();
  }, [clearShowScrollTimeout]);

  useEffect(() => {
    isAtEndRef.current = true;
    lastUserPromptJumpIdRef.current = null;
    transcriptNavigationGenerationRef.current += 1;
    transcriptNavigationRequestIdRef.current += 1;
    clearShowScrollTimeout();
    setShowScrollToBottom(false);
    setHasUnreadMessages(false);
    previousMessageCountRef.current = messagesRef.current.length;
    previousLastMessageIdRef.current = messagesRef.current.at(-1)?.id ?? null;
  }, [clearShowScrollTimeout, state.activeChatId]);

  useEffect(() => {
    function handleGlobalKeydown(event: KeyboardEvent) {
      if (!projectId) return;
      if (event.key === "Shift" && !event.repeat) {
        const now = window.performance.now();
        if (now - lastShiftKeydownRef.current <= 450) {
          event.preventDefault();
          lastShiftKeydownRef.current = 0;
          handleOpenFilesSearch();
          return;
        }
        lastShiftKeydownRef.current = now;
      }

      if (
        actionMatchesEvent(resolvedKeybindings, "toggleEmbeddedTerminal", event)
      ) {
        event.preventDefault();
        handleToggleEmbeddedTerminal();
        return;
      }

      if (
        actionMatchesEvent(resolvedKeybindings, "toggleRightSidebar", event)
      ) {
        event.preventDefault();
        handleToggleGitPanel();
        return;
      }

      if (actionMatchesEvent(resolvedKeybindings, "openInFinder", event)) {
        event.preventDefault();
        void state.handleOpenExternal("open_finder");
        return;
      }

      if (actionMatchesEvent(resolvedKeybindings, "openInEditor", event)) {
        event.preventDefault();
        void state.handleOpenExternal("open_editor");
        return;
      }

      if (actionMatchesEvent(resolvedKeybindings, "addSplitTerminal", event)) {
        event.preventDefault();
        addTerminal(projectId);
      }
    }

    window.addEventListener("keydown", handleGlobalKeydown);
    return () => window.removeEventListener("keydown", handleGlobalKeydown);
  }, [
    addTerminal,
    handleOpenFilesSearch,
    handleToggleEmbeddedTerminal,
    handleToggleGitPanel,
    projectId,
    resolvedKeybindings,
    state.handleOpenExternal,
  ]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      syncIsAtEndFromList();
    });
    const timeoutId = window.setTimeout(() => {
      syncIsAtEndFromList();
    }, TERMINAL_TOGGLE_ANIMATION_DURATION_MS);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [shouldRenderTerminalLayout, showTerminalPane, syncIsAtEndFromList]);

  useEffect(() => {
    function handleResize() {
      syncIsAtEndFromList();
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [syncIsAtEndFromList]);

  useEffect(() => {
    if (!showRightSidebar || !isMobileRightSidebarOverlay) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileRightSidebarOverlay, showRightSidebar]);

  useEffect(() => {
    if (!showRightSidebar || !isMobileRightSidebarOverlay) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleCloseRightSidebar();
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [handleCloseRightSidebar, isMobileRightSidebarOverlay, showRightSidebar]);

  useEffect(() => {
    if (!isAtEndRef.current) {
      return;
    }

    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      void transcriptListRef.current?.scrollToEnd?.({ animated: false });
      secondFrame = window.requestAnimationFrame(() => {
        void transcriptListRef.current?.scrollToEnd?.({ animated: false });
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    state.commandError,
    state.isDraining,
    state.isProcessing,
    state.queuedMessages.length,
    state.runtimeStatus,
    transcriptTailVersion,
  ]);

  useLayoutEffect(() => {
    if (
      !showRightSidebar ||
      isMobileRightSidebarOverlay ||
      layoutWidth <= 0 ||
      isRightSidebarAnimating.current
    ) {
      return;
    }

    const clampedRightSidebarSize = getRightSidebarSizePercent(
      globalRightSidebarSize,
      layoutWidth,
    );
    const currentLayout = rightSidebarPanelGroupRef.current?.getLayout();
    if (!currentLayout) return;
    if (
      Math.abs((currentLayout.rightSidebar ?? 0) - clampedRightSidebarSize) <
      0.1
    ) {
      return;
    }

    rightSidebarPanelGroupRef.current?.setLayout(
      getOrderedRightSidebarLayout(
        100 - clampedRightSidebarSize,
        clampedRightSidebarSize,
        direction,
      ),
    );
  }, [
    direction,
    globalRightSidebarSize,
    isRightSidebarAnimating,
    layoutWidth,
    rightSidebarPanelGroupRef,
    showRightSidebar,
    isMobileRightSidebarOverlay,
  ]);

  const projectFilePreviewPathLabel =
    projectFilePreview?.path ?? projectFilePreviewTarget?.path ?? "";
  const projectFilePreviewProjectPath =
    state.runtime?.localPath ?? state.navbarLocalPath ?? null;
  const projectFilePreviewResolvedPath = projectFilePreviewTarget
    ? resolveDiffFilePath(
        projectFilePreviewProjectPath,
        projectFilePreviewTarget.path,
      )
    : "";
  const canOpenProjectFilePreviewRoute = Boolean(
    projectFilePreviewTarget &&
    (projectFilePreviewProjectPath ||
      isAbsoluteLocalPath(projectFilePreviewTarget.path)),
  );
  const projectFilePreviewRouteHref = canOpenProjectFilePreviewRoute
    ? fileRouteHref(projectFilePreviewResolvedPath, projectFilePreview?.line)
    : "";
  const projectFilePreviewContent = projectFilePreviewTarget ? (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      style={{
        paddingBottom: transcriptPaddingBottom,
        paddingTop: PROJECT_FILE_PREVIEW_NAVBAR_OFFSET_PX,
      }}
    >
      <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3 md:px-5">
        <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-border/70 bg-card/45 shadow-xl shadow-background/20 backdrop-blur">
          <div className="grid h-[52px] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 bg-card/55 px-3 md:px-4">
            <div className="min-w-0 text-start">
              <div
                className="truncate text-sm font-semibold leading-5 text-foreground"
                dir="auto"
              >
                {projectFilePreviewTarget.name}
              </div>
              <div
                className="truncate font-mono text-[11px] leading-4 text-muted-foreground"
                dir="ltr"
              >
                {projectFilePreviewPathLabel}
              </div>
            </div>
            <div
              className="flex shrink-0 items-center gap-0.5 rounded-xl border border-border/70 bg-background/55 p-0.5 shadow-sm"
              dir="ltr"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={!projectFilePreviewRouteHref}
                className="h-7 w-7 rounded-xl text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:opacity-40"
                aria-label={t.browserPanel.openInNewTab}
                title={t.browserPanel.openInNewTab}
                onClick={() => {
                  if (!projectFilePreviewRouteHref) return;
                  window.open(
                    projectFilePreviewRouteHref,
                    "_blank",
                    "noopener,noreferrer",
                  );
                }}
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-xl text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                aria-label={t.filesPanel.closePreview}
                title={t.filesPanel.closePreview}
                onClick={handleCloseProjectFilePreview}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-background/35">
            {projectFilePreview ? (
              <div
                ref={projectPreviewRootRef}
                className="relative h-full min-h-0 select-text"
                {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}
              >
                <Suspense fallback={<PaneLoading />}>
                  <LazyFilePreviewPanel
                    preview={projectFilePreview}
                    title={projectFilePreviewTarget.name}
                    hideHeader
                    surface="bare"
                    className="h-full"
                    codeFrameClassName="h-full !rounded-none !border-0 !bg-transparent !shadow-none"
                  />
                </Suspense>
                {projectFilePreviewLoading ? (
                  <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t.filesPanel.loadingPreview}
                  </div>
                ) : null}
              </div>
            ) : projectFilePreviewLoading ? (
              <div className="flex h-full items-center justify-center">
                <div className="flex w-full max-w-xl flex-col items-center gap-3 rounded-3xl bg-muted/30 px-6 py-8 text-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <div className="text-sm font-medium text-foreground">
                    {t.filesPanel.loadingPreview}
                  </div>
                  <div
                    className="max-w-full truncate font-mono text-xs text-muted-foreground"
                    dir="ltr"
                  >
                    {projectFilePreviewTarget.path}
                  </div>
                </div>
              </div>
            ) : projectFilePreviewError ? (
              <div className="flex h-full items-center justify-center">
                <div className="w-full max-w-2xl rounded-3xl bg-muted/30 px-6 py-6">
                  <div className="text-sm font-semibold text-foreground">
                    {t.filesPanel.previewUnavailable}
                  </div>
                  <div
                    className="mt-1 truncate font-mono text-xs text-muted-foreground"
                    dir="ltr"
                  >
                    {projectFilePreviewTarget.path}
                  </div>
                  <div
                    className="mt-4 whitespace-pre-wrap rounded-2xl bg-background/55 px-4 py-3 text-xs leading-6 text-muted-foreground"
                    dir="auto"
                  >
                    {projectFilePreviewError}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t.filesPanel.selectFile}
              </div>
            )}
          </div>
        </div>
      </div>

      <ProjectPreviewSelectionOverlay
        rootRef={projectPreviewRootRef}
        preview={projectFilePreview}
        path={projectFilePreviewTarget?.path ?? projectFilePreview?.path ?? ""}
        projectRoot={projectFilePreviewProjectPath}
        label={t.filesPanel.addSelectionToPrompt}
        onAppend={appendTextToComposer}
      />
    </div>
  ) : null;

  const chatCard = (
    <Card
      ref={chatCardRef}
      className={cn(
        "bg-background h-full flex flex-col overflow-hidden border-0 rounded-none relative",
        getAppearanceThemeClassName(appearanceSettings),
      )}
      onDragEnter={handleTranscriptDragEnter}
      onDragOver={handleTranscriptDragOver}
      onDragLeave={handleTranscriptDragLeave}
      onDrop={handleTranscriptDrop}
    >
      <CardContent className="flex flex-1 min-h-0 flex-col overflow-hidden p-0 relative">
        <ChatNavbar
          sidebarCollapsed={state.sidebarCollapsed}
          onOpenSidebar={state.openSidebar}
          onExpandSidebar={state.expandSidebar}
          onNewChat={state.handleCompose}
          onAddProject={state.openAddProjectModal}
          localPath={state.navbarLocalPath}
          embeddedTerminalVisible={showTerminalPane}
          onToggleEmbeddedTerminal={
            projectId ? handleToggleEmbeddedTerminal : undefined
          }
          rightPanel={activeRightPanel}
          onToggleGitPanel={projectId ? handleToggleGitPanel : undefined}
          onToggleBrowserPanel={
            projectId ? handleToggleBrowserPanel : undefined
          }
          onToggleFilesPanel={projectId ? handleToggleFilesPanel : undefined}
          onOpenExternal={handleOpenExternal}
          activeChatId={state.activeChatId}
          messages={state.messages}
          sessionId={
            state.runtime?.provider === "codex" ? codexSessionId : null
          }
          sessionPath={
            state.runtime?.provider === "codex" ? codexSessionPath : null
          }
          onChatSearchResultSelect={
            state.activeChatId ? handleChatSearchResultSelect : undefined
          }
          editorPreset={editorPreset}
          editorCommandTemplate={editorCommandTemplate}
          platform={state.localProjects?.machine.platform}
          finderShortcut={resolvedKeybindings.bindings.openInFinder}
          editorShortcut={resolvedKeybindings.bindings.openInEditor}
          terminalShortcut={resolvedKeybindings.bindings.toggleEmbeddedTerminal}
          rightSidebarShortcut={resolvedKeybindings.bindings.toggleRightSidebar}
          branchName={state.chatDiffSnapshot?.branchName}
          hasGitRepo={state.chatDiffSnapshot?.status !== "no_repo"}
          gitStatus={state.chatDiffSnapshot?.status}
        />
        {projectFilePreviewContent ?? (
          <Suspense fallback={<PaneLoading />}>
            <LazyChatTranscriptViewport
              activeChatId={state.activeChatId}
              listRef={transcriptListRef}
              messages={state.messages}
              queuedMessages={state.queuedMessages}
              transcriptPaddingBottom={transcriptPaddingBottom}
              localPath={state.runtime?.localPath}
              latestToolIds={state.latestToolIds}
              isHistoryLoading={state.isHistoryLoading}
              hasOlderHistory={state.hasOlderHistory}
              isProcessing={state.isProcessing}
              runtimeStatus={state.runtimeStatus}
              runtimeProvider={state.runtime?.provider ?? null}
              readOnly={codexChatReadOnly}
              isDraining={state.isDraining}
              commandError={state.commandError}
              loadOlderHistory={state.loadOlderHistory}
              onStopDraining={state.handleStopDraining}
              onRemoveQueuedMessage={state.handleRemoveQueuedMessage}
              onSteerQueuedMessage={state.handleSteerQueuedMessage}
              onInterruptQueuedMessage={state.handleInterruptQueuedMessage}
              onEditQueuedMessage={handleEditQueuedMessage}
              onRemoveAllQueuedMessages={handleRemoveAllQueuedMessages}
              onOpenLocalLink={state.handleOpenLocalLink}
              editorPreset={editorPreset}
              editorCommandTemplate={editorCommandTemplate}
              platform={state.localProjects?.machine.platform}
              onAskUserQuestionSubmit={state.handleAskUserQuestion}
              onApprovalRequestSubmit={state.handleApprovalRequest}
              onExitPlanModeConfirm={state.handleExitPlanMode}
              onRetryTurn={handleRetryFailedTurn}
              checkpoints={state.chatDiffSnapshot?.checkpoints ?? []}
              onRestoreCheckpoint={state.handleRestoreCheckpoint}
              showScrollButton={showScrollToBottom && state.messages.length > 0}
              showUnreadDot={hasUnreadMessages}
              onIsAtEndChange={onIsAtEndChange}
              scrollToBottom={() => scrollToTranscriptEnd(true)}
              typedEmptyStateText={typedEmptyStateText}
              isEmptyStateTypingComplete={isEmptyStateTypingComplete}
              isPageFileDragActive={isPageFileDragActive}
              showEmptyState={showEmptyState}
              emptyStateText={t.chat.emptyState}
              onMinimapScrollToMessage={handleMinimapScrollToMessage}
            />
          </Suspense>
        )}
      </CardContent>

      <ChatInputDock
        inputRef={inputRef}
        onLayoutChange={syncInputHeight}
        chatInputRef={chatInputRef}
        chatInputElementRef={chatInputElementRef}
        activeChatId={state.activeChatId}
        previousPrompt={state.previousPrompt}
        onJumpToPreviousUserPrompt={
          state.activeChatId ? handleJumpToPreviousUserPrompt : undefined
        }
        hasSelectedProject={state.hasSelectedProject}
        connectionStatus={state.connectionStatus}
        runtimeStatus={state.runtimeStatus}
        processingStatus={getProcessingStatus(state.messages, state.runtimeStatus ?? undefined)}
        turnStartedAt={state.runtime?.turnStartedAt}
        canCancel={state.canCancel}
        projectId={projectId}
        activeProvider={state.runtime?.provider ?? null}
        availableProviders={state.availableProviders}
        contextWindowSnapshot={contextWindowSnapshot}
        rateLimitSnapshot={rateLimitSnapshot}
        accountEmail={accountEmail}
        onAccountActivated={refreshUsageAfterAccountActivation}
        readOnly={codexChatReadOnly}
        codexLock={codexLock}
        lockBusy={codexLockActionPending}
        onRefreshSessionLock={() => {
          void refreshCodexLock();
        }}
        onTakeOverSession={(executionMode) => {
          void takeOverCodexLock(executionMode);
        }}
        onReleaseSession={() => {
          void releaseCodexLock();
        }}
        onCodexExecutionModeChange={(executionMode) => {
          void changeCodexExecutionMode(executionMode);
        }}
        runtimePlanMode={state.runtime?.planMode}
        onRuntimePreferenceChange={changeRuntimePreference}
        onRuntimePlanModeChange={changeRuntimePlanMode}
        onReloadCodexAuth={() => {
          void reloadCodexAuth();
        }}
        onSubmit={handleChatSubmit}
        onCancel={handleCancel}
      />
    </Card>
  );

  const workspace = projectId ? (
    <ChatWorkspace
      chatCard={chatCard}
      projectId={projectId}
      shouldRenderTerminalLayout={shouldRenderTerminalLayout}
      showTerminalPane={showTerminalPane}
      terminalLayout={terminalLayout}
      mainPanelGroupRef={mainPanelGroupRef}
      terminalPanelRef={terminalPanelRef}
      terminalVisualRef={terminalVisualRef}
      fixedTerminalHeight={fixedTerminalHeight}
      terminalFocusRequestVersion={terminalFocusRequestVersion}
      addTerminal={addTerminal}
      socket={state.socket}
      connectionStatus={state.connectionStatus}
      scrollback={scrollback}
      minColumnWidth={minColumnWidth}
      splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
      pendingCommandsByTerminalId={pendingTerminalCommands}
      onTerminalCommandSent={scheduleTerminalDiffRefresh}
      onInitialTerminalCommandSent={handleInitialTerminalCommandSent}
      onRemoveTerminal={handleRemoveTerminal}
      onTerminalLayout={setTerminalSizes}
      onLayoutChanged={handleTerminalResize}
    />
  ) : (
    chatCard
  );

  const gitPanelContentProps = useMemo<ComponentProps<
    typeof ChatSidebarContent
  > | null>(() => {
    if (!projectId) {
      return null;
    }

    return {
      projectId,
      diffs: state.chatDiffSnapshot ?? EMPTY_DIFF_SNAPSHOT,
      editorLabel: state.editorLabel,
      diffRenderMode,
      wrapLines: wrapDiffLines,
      onOpenFile: handleOpenDiffFile,
      onOpenInFinder: handleOpenDiffInFinder,
      onDiscardFile: handleDiscardDiffFile,
      onIgnoreFile: handleIgnoreDiffFile,
      onIgnoreFolder: handleIgnoreDiffFolder,
      onCopyFilePath: handleCopyDiffFilePath,
      onCopyRelativePath: handleCopyDiffRelativePath,
      onLoadPatch: handleLoadDiffPatch,
      onListBranches: handleListBranches,
      onPreviewMergeBranch: handlePreviewMergeBranch,
      onMergeBranch: handleMergeBranch,
      onCheckoutBranch: handleCheckoutBranch,
      onCreateBranch: handleCreateBranch,
      onGenerateCommitMessage: handleGenerateCommitMessage,
      onInitializeGit: handleInitializeGit,
      onGetGitHubPublishInfo: handleGetGitHubPublishInfo,
      onCheckGitHubRepoAvailability: handleCheckGitHubRepoAvailability,
      onSetupGitHub: handleSetupGitHub,
      onCommit: handleCommitDiffs,
      onSyncWithRemote: handleSyncBranch,
      onDiffRenderModeChange: setDiffRenderMode,
      onWrapLinesChange: setWrapDiffLines,
      onClose: handleCloseRightSidebar,
    };
  }, [
    diffRenderMode,
    handleCheckGitHubRepoAvailability,
    handleCheckoutBranch,
    handleCloseRightSidebar,
    handleCommitDiffs,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleCreateBranch,
    handleDiscardDiffFile,
    handleGenerateCommitMessage,
    handleGetGitHubPublishInfo,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleInitializeGit,
    handleListBranches,
    handleLoadDiffPatch,
    handleMergeBranch,
    handleOpenDiffFile,
    handleOpenDiffInFinder,
    handlePreviewMergeBranch,
    handleSetupGitHub,
    handleSyncBranch,
    projectId,
    setDiffRenderMode,
    setWrapDiffLines,
    state.chatDiffSnapshot,
    state.editorLabel,
    wrapDiffLines,
  ]);
  const rightPanelContent =
    activeRightPanel === "browser" && projectId ? (
      <Suspense fallback={<PaneLoading />}>
        <LazyBrowserPanel
          projectId={projectId}
          socket={state.socket}
          onClose={handleCloseRightSidebar}
          onRunQuickAction={handleRunQuickAction}
        />
      </Suspense>
    ) : activeRightPanel === "files" && projectId ? (
      <Suspense fallback={<PaneLoading />}>
        <LazyProjectFilesPanel
          projectId={projectId}
          localPath={state.runtime?.localPath ?? state.navbarLocalPath}
          initialPath={projectFilePreviewTarget?.path}
          previewMode="none"
          showCloseButton={false}
          focusSearchToken={filesPanelFocusToken || undefined}
          onClose={handleCloseRightSidebar}
          onSelectFile={handleSelectProjectFile}
          onOpenFile={handleOpenDiffFile}
          onOpenInFinder={handleOpenDiffInFinder}
          onCopyFilePath={handleCopyDiffFilePath}
          onCopyRelativePath={handleCopyDiffRelativePath}
        />
      </Suspense>
    ) : activeRightPanel === "git" && gitPanelContentProps ? (
      <ChatSidebarContent {...gitPanelContentProps} />
    ) : null;
  const rightSidebarPanelDefaultSizes = getRightSidebarPanelDefaultSizes(
    showRightSidebar,
    effectiveRightSidebarSize,
  );
  const workspacePanel = (
    <ResizablePanel
      id="workspace"
      defaultSize={rightSidebarPanelDefaultSizes.workspace}
      minSize="20%"
      dir={direction}
      className="min-h-0 min-w-0"
      groupResizeBehavior="preserve-relative-size"
    >
      {workspace}
    </ResizablePanel>
  );
  const rightSidebarPanel = (
    <DesktopSidebarPane
      showRightSidebar={showRightSidebar}
      sizePercent={rightSidebarPanelDefaultSizes.rightSidebar}
      direction={direction}
      sidebarPanelRef={sidebarPanelRef}
      sidebarVisualRef={sidebarVisualRef}
      content={rightPanelContent}
    />
  );
  const rightSidebarHandle = (
    <ResizableHandle
      withHandle={false}
      orientation="horizontal"
      disabled={!showRightSidebar}
      className={cn(!showRightSidebar && "pointer-events-none opacity-0")}
    />
  );

  return (
    <div ref={layoutRootRef} className="flex-1 flex flex-col min-w-0 relative">
      {shouldRenderDesktopRightSidebarLayout && projectId ? (
        <ResizablePanelGroup
          key={`${projectId}-right-sidebar-${direction}`}
          dir="ltr"
          groupRef={rightSidebarPanelGroupRef}
          orientation="horizontal"
          className="flex-1 min-h-0"
          onLayoutChange={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return;
            }

            const clampedRightSidebarSize = getRightSidebarSizePercent(
              getRightSidebarSizePx(layout.rightSidebar, layoutWidth),
              layoutWidth,
            );
            if (Math.abs(clampedRightSidebarSize - layout.rightSidebar) < 0.1) {
              return;
            }

            rightSidebarPanelGroupRef.current?.setLayout(
              getOrderedRightSidebarLayout(
                100 - clampedRightSidebarSize,
                clampedRightSidebarSize,
                direction,
              ),
            );
          }}
          onLayoutChanged={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return;
            }

            setRightSidebarSize(
              getRightSidebarSizePx(layout.rightSidebar, layoutWidth),
            );
          }}
        >
          {isRtl ? rightSidebarPanel : workspacePanel}
          {rightSidebarHandle}
          {isRtl ? workspacePanel : rightSidebarPanel}
        </ResizablePanelGroup>
      ) : (
        workspace
      )}
      {isMobileRightSidebarOverlay ? (
        <MobileSidebarPane
          projectId={projectId}
          showRightSidebar={showRightSidebar}
          isRtl={isRtl}
          sidebarVisualRef={sidebarVisualRef}
          onClose={handleCloseRightSidebar}
          content={rightPanelContent}
        />
      ) : null}
    </div>
  );
}
