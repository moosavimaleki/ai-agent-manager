import { memo, type RefObject } from "react";
import type {
  AgentProvider,
  CodexExecutionMode,
  CodexLockStatus,
  ModelOptions,
  RateLimitSnapshot,
} from "../../../shared/types";
import {
  ChatInput,
  type ChatInputHandle,
} from "../../components/chat-ui/ChatInput";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import type { AbolqasemState } from "../useAbolqasemState";

interface ChatInputDockProps {
  inputRef: RefObject<HTMLDivElement | null>;
  onLayoutChange: () => void;
  chatInputRef: RefObject<ChatInputHandle | null>;
  chatInputElementRef: RefObject<HTMLTextAreaElement | null>;
  activeChatId: string | null;
  previousPrompt: string | null;
  onJumpToPreviousUserPrompt?: () => void | Promise<void>;
  hasSelectedProject: boolean;
  connectionStatus: AbolqasemState["connectionStatus"];
  runtimeStatus: string | null;
  processingStatus?: string | null;
  turnStartedAt?: number | null;
  canCancel: boolean;
  projectId: string | null;
  activeProvider: AgentProvider | null;
  availableProviders: AbolqasemState["availableProviders"];
  contextWindowSnapshot: ContextWindowSnapshot | null;
  rateLimitSnapshot: RateLimitSnapshot | null;
  accountEmail?: string | null;
  onAccountActivated?: () => void | Promise<void>;
  readOnly?: boolean;
  codexLock?: CodexLockStatus | null;
  lockBusy?: boolean;
  onTakeOverSession?: (executionMode: CodexExecutionMode) => void;
  onReleaseSession?: () => void;
  onRefreshSessionLock?: () => void;
  onCodexExecutionModeChange?: (executionMode: CodexExecutionMode) => void;
  runtimePlanMode?: boolean;
  onRuntimePlanModeChange?: (planMode: boolean) => Promise<void>;
  onReloadCodexAuth?: () => void;
  onSubmit: AbolqasemState["handleSend"];
  onRuntimePreferenceChange?: (preference: {
    provider: AgentProvider;
    model: string;
    modelOptions: ModelOptions;
  }) => Promise<void>;
  onCancel: () => void;
}

export const ChatInputDock = memo(function ChatInputDock({
  inputRef,
  onLayoutChange,
  chatInputRef,
  chatInputElementRef,
  activeChatId,
  previousPrompt,
  onJumpToPreviousUserPrompt,
  hasSelectedProject,
  connectionStatus,
  runtimeStatus,
  processingStatus = null,
  turnStartedAt = null,
  canCancel,
  projectId,
  activeProvider,
  availableProviders,
  contextWindowSnapshot,
  rateLimitSnapshot,
  accountEmail = null,
  onAccountActivated,
  readOnly = false,
  codexLock = null,
  lockBusy = false,
  onTakeOverSession,
  onReleaseSession,
  onRefreshSessionLock,
  onCodexExecutionModeChange,
  runtimePlanMode,
  onRuntimePlanModeChange,
  onReloadCodexAuth,
  onSubmit,
  onRuntimePreferenceChange,
  onCancel,
}: ChatInputDockProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
      <div
        className="bg-gradient-to-t from-background via-background pointer-events-auto"
        ref={inputRef}
      >
        <ChatInput
          ref={chatInputRef}
          inputElementRef={chatInputElementRef}
          onLayoutChange={onLayoutChange}
          key={activeChatId ?? "new-chat"}
          onSubmit={onSubmit}
          onRuntimePreferenceChange={onRuntimePreferenceChange}
          runtimePlanMode={runtimePlanMode}
          onRuntimePlanModeChange={onRuntimePlanModeChange}
          onCancel={onCancel}
          disabled={!hasSelectedProject}
          connectionStatus={connectionStatus}
          runtimeStatus={runtimeStatus}
          processingStatus={processingStatus}
          turnStartedAt={turnStartedAt}
          canCancel={canCancel}
          chatId={activeChatId}
          projectId={projectId}
          activeProvider={activeProvider}
          availableProviders={availableProviders}
          showPreferenceControls
          contextWindowSnapshot={contextWindowSnapshot}
          rateLimitSnapshot={rateLimitSnapshot}
          accountEmail={accountEmail}
          onAccountActivated={onAccountActivated}
          readOnly={readOnly}
          codexLock={codexLock}
          lockBusy={lockBusy}
          onTakeOverSession={onTakeOverSession}
          onReleaseSession={onReleaseSession}
          onRefreshSessionLock={onRefreshSessionLock}
          onCodexExecutionModeChange={onCodexExecutionModeChange}
          onReloadCodexAuth={onReloadCodexAuth}
          previousPrompt={previousPrompt}
          onJumpToPreviousUserPrompt={onJumpToPreviousUserPrompt}
        />
      </div>
    </div>
  );
});
