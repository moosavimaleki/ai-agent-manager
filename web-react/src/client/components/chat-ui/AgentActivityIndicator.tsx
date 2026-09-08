import { useEffect, useState } from "react"
import { CircleHelp, LoaderCircle } from "lucide-react"
import type { AgentProvider } from "../../../shared/types"
import { useI18n } from "../../i18n/context"
import { cn } from "../../lib/utils"

interface AgentActivityIndicatorProps {
  runtimeStatus?: string | null
  activity?: string | null
  provider?: AgentProvider | null
  startedAt?: number | null
}

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function AgentActivityIndicator({
  runtimeStatus,
  activity,
  provider,
  startedAt,
}: AgentActivityIndicatorProps) {
  const { t } = useI18n()
  const active = runtimeStatus === "starting" || runtimeStatus === "running" || runtimeStatus === "waiting_for_user"
  const [fallbackStartedAt, setFallbackStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    setFallbackStartedAt(Date.now())
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, startedAt])

  if (!active) return null

  const labels: Record<string, string> = {
    starting: t.composer.agentStarting,
    thinking: t.composer.agentThinking,
    running_command: t.composer.agentRunningCommand,
    running_mcp_tool: t.composer.agentRunningMcpTool,
    applying_changes: t.composer.agentApplyingChanges,
    writing_response: t.composer.agentWritingResponse,
    waiting_for_user: t.composer.agentWaitingForUser,
  }
  const effectiveActivity = runtimeStatus === "waiting_for_user"
    ? "waiting_for_user"
    : activity || runtimeStatus || "running"
  const label = labels[effectiveActivity] ?? t.composer.agentWorking
  const providerLabel = provider === "claude"
    ? "Claude"
    : provider === "opencode"
      ? "OpenCode"
      : "Codex app-server"
  const elapsed = formatElapsed(now - (startedAt && startedAt > 0 ? startedAt : fallbackStartedAt))
  const waiting = effectiveActivity === "waiting_for_user"

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${providerLabel}: ${label}, ${t.composer.agentActiveFor(elapsed)}`}
      className={cn(
        "mb-1.5 flex min-w-0 items-center justify-center gap-2 px-3 text-xs",
        waiting ? "text-amber-600 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300",
      )}
    >
      {waiting ? (
        <CircleHelp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <LoaderCircle
          className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      <span className="truncate">
        <span className="font-medium">{providerLabel}</span>
        <span className="mx-1.5 text-muted-foreground" aria-hidden="true">·</span>
        <span>{label}</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums text-muted-foreground" dir="ltr">
        {elapsed}
      </span>
    </div>
  )
}
