import { hydrateToolResult } from "../../shared/tools"
import type { HydratedToolCall, HydratedTranscriptMessage, NormalizedToolCall, TranscriptEntry } from "../../shared/types"

function createTimestamp(createdAt: number): string {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

function createBaseMessage(entry: TranscriptEntry) {
  return {
    id: entry._id,
    messageId: entry.messageId,
    timestamp: createTimestamp(entry.createdAt),
    hidden: entry.hidden,
  }
}

function isTmuxCaptureEntry(entry: Extract<TranscriptEntry, { kind: "assistant_text" }>) {
  return entry._id.startsWith("tmux-capture-")
}

function stripAnsi(text: string) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
}

function cleanTmuxCaptureLine(line: string) {
  const trimmedRight = line.replace(/\s+$/g, "")
  const borderOnly = /^[\s+\-|=._:]*[\u2500-\u257f]+[\s+\-|=._:]*$/
  if (borderOnly.test(trimmedRight)) return ""

  const boxed = trimmedRight.match(/^\s*[\u2502\u2503]\s?(.*?)\s?[\u2502\u2503]\s*$/)
  return (boxed?.[1] ?? trimmedRight).trimEnd()
}

function isShellCommandLine(line: string) {
  return /^\s*(?:[$>#]\s*)?(?:awk|bun|cargo|cat|cd|claude|codex|curl|deno|docker|git|go|grep|kubectl|ls|make|node|npm|pnpm|python\d*|rg|sed|ssh|sudo|tmux|uv|yarn)\b/.test(line)
}

function shellCommandContinues(line: string) {
  return /(?:\\|[|&]{1,2})\s*$/.test(line.trimEnd())
}

function isShellContinuationLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return false
  return /^(?:\\|[|&]{1,2}|[<>]|-[A-Za-z]|--[A-Za-z]|jq\b|grep\b|sed\b|awk\b|python\d*\b|node\b)/.test(trimmed)
}

function hasRTLText(line: string) {
  return /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/.test(line)
}

function isFencedCodeMarker(line: string) {
  return /^\s*```/.test(line)
}

function isMermaidStartLine(line: string) {
  return /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart)\b/.test(line)
}

function isMermaidContinuationLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return false
  return /^\s+\S/.test(line)
    || /(?:-->|---|==>|-.->|\|)/.test(trimmed)
    || /^[A-Za-z0-9_]+\s*(?:\[|\(|\{|-->|---|==>)/.test(trimmed)
}

function isCliHelpOptionLine(line: string) {
  return /^\s{2,}(?:-[\w-]|--[\w-])/.test(line)
    || /^\s{2,}[A-Za-z][\w-]*(?: [A-Za-z][\w-]*)* {2,}\S/.test(line)
}

function isRenderableMermaidBlock(lines: string[]) {
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean)
  if (nonEmpty.length < 2 || !nonEmpty.some(isMermaidStartLine)) return false
  return nonEmpty.slice(1).some((line) => /(?:-->|---|==>|-.->|\[|\(|\{|:)/.test(line))
}

function isLikelyCodeLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (isFencedCodeMarker(trimmed)) return false
  if (isCliHelpOptionLine(line)) return false
  if (hasRTLText(trimmed)) return false
  if (/^\s{2,}\S/.test(line) && /[A-Za-z_$\\]/.test(trimmed)) return true
  if (/^\s*(?:\/\/|#|\/\*|\*|<!--)/.test(trimmed)) return true
  if (/^\s*(?:const|let|var|export|import|from|function|class|interface|type|enum|namespace|use|public|private|protected|static|final|return|if|else|for|foreach|while|switch|case|try|catch|finally|package|func|struct|type|map)\b/.test(trimmed)) return true
  if (/^\s*(?:\$[A-Za-z_][\w]*|[A-Za-z_\\][\w\\]*::|[A-Za-z_$][\w$]*\s*(?:=|=>|->|::|\(|\[))/.test(trimmed) && /[{}[\]();=]/.test(trimmed)) return true
  if (/^\s*[}\])];,]+$/.test(trimmed)) return true
  if (/^\s*[-\w"']+\s*:\s*.+[,;]?$/.test(trimmed) && /[,[\]{}()]/.test(trimmed)) return true
  return false
}

function inferCodeLanguage(lines: string[]) {
  const source = lines.join("\n")
  if (lines.some(isMermaidStartLine)) return "mermaid"
  if (/<\?php\b|\$this\b|->|::|\\[A-Z][A-Za-z_\\]+/.test(source)) return "php"
  if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\(/.test(source)) return "go"
  if (/\b(?:import|export|const|let|type|interface)\b/.test(source)) return "ts"
  if (/\b(?:def|class)\s+\w+|^\s*from\s+\w+\s+import\b/m.test(source)) return "python"
  if (/^\s*[{[]\s*$/.test(source) || /^\s*"[^"]+"\s*:/m.test(source)) return "json"
  return ""
}

function isTmuxChromeLine(line: string) {
  return isAgentStatusLine(line)
    || isTmuxWorkingLine(line)
    || isTmuxInteractiveInstructionLine(line)
    || /^worked for \d/i.test(line)
    || /^conversation interrupted\b/i.test(line)
    || /^press enter to confirm or esc to go back\b/i.test(line)
    || /^no tmux output captured\b/i.test(line)
}

function isTmuxWorkingLine(line: string) {
  return /^working\b.*\besc to interrupt\b/i.test(line)
}

function isTmuxInteractiveInstructionLine(line: string) {
  return /^press enter to confirm or esc to go back\b/i.test(line)
    || /^hit `?\/feedback`? to report the issue\b/i.test(line)
}

function isLikelyAssistantStartAfterPrompt(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (isTmuxAssistantBullet(trimmed) || isTmuxWarningLine(trimmed) || isTmuxChromeLine(trimmed)) return true
  if (/^(?:i(?:\s|\u2019|\x27)|i\x27ll|i\u2019ll|i am|i\x27m|i\u2019m|sure[, ]|here\b|the\b|this\b|that\b|we\b|let\x27s|let\u2019s)\b/i.test(trimmed)) return true
  if (/^[A-Z][A-Za-z0-9 ,;:\-\x27\u2019()]+[.!?:]$/.test(trimmed)) return true
  return false
}

function isAgentStatusLine(line: string) {
  return /^gpt-[\w.-]+\s+/i.test(line)
    || /^claude(?:\s|[-\w.]+\s)/i.test(line)
	|| /\b(?:codex|claude)\b.*\b(?:context|tokens|model|cwd|directory)\b/i.test(line)
}

function isTmuxWarningLine(line: string) {
  return /^⚠/.test(line)
    || /\bMCP\b.*\b(?:failed|startup|incomplete|interrupted|error|timeout|timed out)\b/i.test(line)
    || /\bHTTP 404\b/.test(line)
    || /\brate limits?\b/i.test(line)
    || /\bunexpected server response\b/i.test(line)
}

function isTmuxAssistantBullet(line: string) {
  return /^•\s+/.test(line)
}

function tmuxAssistantLineText(line: string) {
  return isTmuxAssistantBullet(line) ? line.replace(/^•\s+/, "") : line
}

function tmuxUserPromptText(line: string) {
  const match = line.match(/^(?:›|>|❯|\$|#)\s+(.+)$/)
  return match?.[1]?.trim() ?? null
}

function wrapTmuxCommandRuns(lines: string[]) {
  const wrapped: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (!isShellCommandLine(line)) {
      wrapped.push(line)
      continue
    }

    const commands: string[] = []
    let previousContinues = false
    while (index < lines.length) {
      const current = lines[index] ?? ""
      const commandStart = isShellCommandLine(current)
      if (commands.length === 0) {
        if (!commandStart) break
      } else if (!previousContinues || (!commandStart && !isShellContinuationLine(current))) {
        break
      }

      commands.push(current.replace(/^\s*[$>#]\s*/, ""))
      previousContinues = shellCommandContinues(current)
      index += 1
    }
    index -= 1

    if (wrapped.at(-1)?.trim()) wrapped.push("")
    wrapped.push("```shell", ...commands, "```")
    if ((lines[index + 1] ?? "").trim()) wrapped.push("")
  }
  return wrapped
}

function wrapTmuxWarningRuns(lines: string[]) {
  const wrapped: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (!isTmuxWarningLine(line)) {
      wrapped.push(line)
      continue
    }

    const warnings: string[] = []
    while (index < lines.length && isTmuxWarningLine(lines[index] ?? "")) {
      warnings.push(lines[index] ?? "")
      index += 1
    }
    index -= 1

    if (wrapped.at(-1)?.trim()) wrapped.push("")
    wrapped.push("```text", ...warnings, "```")
    if ((lines[index + 1] ?? "").trim()) wrapped.push("")
  }
  return wrapped
}

function wrapTmuxCodeRuns(lines: string[]) {
  const wrapped: string[] = []
  let inFence = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (isFencedCodeMarker(line)) {
      inFence = !inFence
      wrapped.push(line)
      continue
    }
    if (inFence || (!isMermaidStartLine(line) && !isLikelyCodeLine(line))) {
      wrapped.push(line)
      continue
    }

    const codeLines: string[] = []
    const mermaidRun = isMermaidStartLine(line)
    while (index < lines.length) {
      const current = lines[index] ?? ""
      if (isFencedCodeMarker(current)) {
        break
      }
      if (mermaidRun) {
        if (codeLines.length > 0 && !isMermaidContinuationLine(current)) {
          break
        }
      } else if (!isLikelyCodeLine(current)) {
        break
      }
      codeLines.push(current)
      index += 1
    }
    index -= 1

    const shouldFence = mermaidRun ? isRenderableMermaidBlock(codeLines) : codeLines.length >= 2 || /[{}[\]();]/.test(codeLines[0] ?? "")
    if (!shouldFence) {
      wrapped.push(...codeLines)
      continue
    }

    const language = inferCodeLanguage(codeLines)
    if (wrapped.at(-1)?.trim()) wrapped.push("")
    wrapped.push(`\`\`\`${language}`, ...codeLines, "```")
    if ((lines[index + 1] ?? "").trim()) wrapped.push("")
  }

  return wrapped
}

function wrapTmuxRichBlocks(lines: string[]) {
  return wrapTmuxWarningRuns(wrapTmuxCodeRuns(wrapTmuxCommandRuns(lines)))
}

export function tmuxCaptureToReadableText(raw: string) {
  const lines = stripAnsi(raw)
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map(cleanTmuxCaptureLine)

  const compacted: string[] = []
  for (const line of lines) {
    if (line.trim() === "" && compacted.at(-1)?.trim() === "") {
      continue
    }
    compacted.push(line)
  }
  return wrapTmuxRichBlocks(compacted).join("\n").trim()
}

function tmuxCaptureLines(raw: string) {
  return stripAnsi(raw)
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map(cleanTmuxCaptureLine)
}

function pushTmuxAssistantMessage(
  messages: HydratedTranscriptMessage[],
  entry: Extract<TranscriptEntry, { kind: "assistant_text" }>,
  lines: string[],
  index: number
) {
  const text = wrapTmuxRichBlocks(lines.map(tmuxAssistantLineText)).join("\n").trim()
  if (!text) return index
  messages.push({
    ...createBaseMessage(entry),
    id: `${entry._id}:assistant-${index}`,
    kind: "assistant_text",
    text,
  })
  return index + 1
}

function pushTmuxUserMessage(
  messages: HydratedTranscriptMessage[],
  entry: Extract<TranscriptEntry, { kind: "assistant_text" }>,
  content: string,
  index: number
) {
  const trimmed = content.trim()
  if (!trimmed) return index
  messages.push({
    ...createBaseMessage(entry),
    id: `${entry._id}:user-${index}`,
    kind: "user_prompt",
    content: trimmed,
    attachments: [],
  })
  return index + 1
}

export function tmuxCaptureToTranscriptMessages(entry: Extract<TranscriptEntry, { kind: "assistant_text" }>): HydratedTranscriptMessage[] {
  const messages: HydratedTranscriptMessage[] = []
  let assistantLines: string[] = []
  let messageIndex = 0
  let pendingUserPromptLines: string[] = []

  const flushAssistant = () => {
    messageIndex = pushTmuxAssistantMessage(messages, entry, assistantLines, messageIndex)
    assistantLines = []
  }

  for (const rawLine of tmuxCaptureLines(entry.text ?? "")) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (!trimmed) {
      if (assistantLines.length > 0 && assistantLines.at(-1)?.trim()) {
        assistantLines.push("")
      }
      continue
    }

    if (isTmuxChromeLine(trimmed)) {
      continue
    }

    const userPrompt = tmuxUserPromptText(trimmed)
    if (userPrompt) {
      flushAssistant()
      pendingUserPromptLines = [userPrompt]
      continue
    }

    if (pendingUserPromptLines.length > 0) {
      if (!isLikelyAssistantStartAfterPrompt(line)) {
        pendingUserPromptLines.push(line.trim())
        continue
      }
      messageIndex = pushTmuxUserMessage(messages, entry, pendingUserPromptLines.join("\n"), messageIndex)
      pendingUserPromptLines = []
    }
    assistantLines.push(line)
  }

  flushAssistant()

  if (messages.length === 0) {
    const text = tmuxCaptureToReadableText(entry.text ?? "")
    if (text) {
      messages.push({
        ...createBaseMessage(entry),
        kind: "assistant_text",
        text,
      })
    }
  }

  return messages
}

function hydrateToolCall(entry: Extract<TranscriptEntry, { kind: "tool_call" }>): HydratedToolCall {
  return {
    id: entry._id,
    messageId: entry.messageId,
    hidden: entry.hidden,
    kind: "tool",
    toolKind: entry.tool.toolKind,
    toolName: entry.tool.toolName,
    toolId: entry.tool.toolId,
    input: entry.tool.input as HydratedToolCall["input"],
    timestamp: createTimestamp(entry.createdAt),
  } as HydratedToolCall
}

function getStructuredToolResultFromDebug(entry: Extract<TranscriptEntry, { kind: "tool_result" }>): unknown {
  if (!entry.debugRaw) return undefined

  try {
    const parsed = JSON.parse(entry.debugRaw) as { tool_use_result?: unknown }
    return parsed.tool_use_result
  } catch {
    return undefined
  }
}

export function processTranscriptMessages(entries: TranscriptEntry[]): HydratedTranscriptMessage[] {
  const pendingToolCalls = new Map<string, { hydrated: HydratedToolCall; normalized: NormalizedToolCall }>()
  const messages: HydratedTranscriptMessage[] = []
  const assistantTexts = new Map<string, Extract<HydratedTranscriptMessage, { kind: "assistant_text" }>>()
  const commandExecutions = new Map<string, Extract<HydratedTranscriptMessage, { kind: "command_execution" }>>()
  const fileChanges = new Map<string, Extract<HydratedTranscriptMessage, { kind: "file_change" }>>()
  const turnPlans = new Map<string, Extract<HydratedTranscriptMessage, { kind: "turn_plan" }>>()
  const proposedPlans = new Map<string, Extract<HydratedTranscriptMessage, { kind: "proposed_plan" }>>()
  const turnActivities = new Map<string, Extract<HydratedTranscriptMessage, { kind: "turn_activity" }>>()
  const internalSystemPayloads = new Set<string>()

  for (const entry of entries) {
    if (entry.kind === "assistant_text" && isTmuxCaptureEntry(entry)) {
      messages.push(...tmuxCaptureToTranscriptMessages(entry))
      continue
    }

    switch (entry.kind) {
      case "user_prompt":
        {
          const systemPayload = extractInternalSystemPayload(entry.content)
          if (systemPayload) {
            if (internalSystemPayloads.has(systemPayload.dedupeKey)) break
            internalSystemPayloads.add(systemPayload.dedupeKey)
          }
        }
        messages.push({
          ...createBaseMessage(entry),
          kind: "user_prompt",
          content: entry.content,
          attachments: entry.attachments ?? [],
          steered: entry.steered,
        })
        break
      case "system_init":
        messages.push({
          ...createBaseMessage(entry),
          kind: "system_init",
          provider: entry.provider,
          model: entry.model,
          tools: entry.tools,
          agents: entry.agents,
          slashCommands: entry.slashCommands,
          mcpServers: entry.mcpServers,
          debugRaw: entry.debugRaw,
        })
        break
      case "account_info":
        messages.push({
          ...createBaseMessage(entry),
          kind: "account_info",
          accountInfo: entry.accountInfo,
        })
        break
      case "assistant_text": {
          const rawText = entry.text ?? entry.textDelta ?? ""
          const visibleText = stripInternalAssistantMetadata(rawText)
          if (!visibleText) break
          // Recent Codex versions can persist internal payloads both as a
          // user_message event and as an assistant text echo. Keep one
          // canonical collapsed row instead of showing a second chat bubble.
          const systemPayload = extractInternalSystemPayload(visibleText)
          if (systemPayload) {
            if (internalSystemPayloads.has(systemPayload.dedupeKey)) break
            internalSystemPayloads.add(systemPayload.dedupeKey)
          }
          if (entry.itemId) {
            const existing = assistantTexts.get(entry.itemId)
            if (existing) {
              existing.text = entry.text !== undefined
                ? stripInternalAssistantMetadata(entry.text)
                : stripInternalAssistantMetadata(existing.text + (entry.textDelta ?? ""))
              existing.status = entry.status
              break
            }
          }
          const assistant = {
            ...createBaseMessage(entry),
            kind: "assistant_text" as const,
            text: stripInternalAssistantMetadata(rawText),
            itemId: entry.itemId,
            status: entry.status,
          }
          if (entry.itemId) assistantTexts.set(entry.itemId, assistant)
          messages.push(assistant)
          break
      }
      case "tool_call": {
        const toolCall = hydrateToolCall(entry)
        pendingToolCalls.set(entry.tool.toolId, { hydrated: toolCall, normalized: entry.tool })
        messages.push(toolCall)
        break
      }
      case "tool_result": {
        const pendingCall = pendingToolCalls.get(entry.toolId)
        if (pendingCall) {
          const rawResult = (
            pendingCall.normalized.toolKind === "ask_user_question" ||
            pendingCall.normalized.toolKind === "approval_request" ||
            pendingCall.normalized.toolKind === "exit_plan_mode"
          )
            ? getStructuredToolResultFromDebug(entry) ?? entry.content
            : entry.content

          pendingCall.hydrated.result = hydrateToolResult(pendingCall.normalized, rawResult) as never
          pendingCall.hydrated.rawResult = rawResult
          pendingCall.hydrated.isError = entry.isError
        }
        break
      }
      case "result":
        messages.push({
          ...createBaseMessage(entry),
          kind: "result",
          success: !entry.isError,
          cancelled: entry.subtype === "cancelled",
          result: entry.result,
          durationMs: entry.durationMs,
          costUsd: entry.costUsd,
        })
        break
      case "status":
        messages.push({
          ...createBaseMessage(entry),
          kind: "status",
          status: entry.status,
        })
        break
      case "command_execution": {
        const existing = commandExecutions.get(entry.itemId)
        if (existing) {
          if (entry.command !== undefined) existing.command = entry.command
          if (entry.cwd !== undefined) existing.cwd = entry.cwd
          existing.status = entry.status
          if (entry.aggregatedOutput !== undefined) existing.aggregatedOutput = entry.aggregatedOutput
          else if (entry.outputDelta) existing.aggregatedOutput += entry.outputDelta
          if (entry.exitCode !== undefined) existing.exitCode = entry.exitCode
          if (entry.durationMs !== undefined) existing.durationMs = entry.durationMs
        } else {
          const command = {
            ...createBaseMessage(entry), kind: "command_execution" as const, itemId: entry.itemId,
            command: entry.command ?? "", cwd: entry.cwd ?? "", status: entry.status,
            aggregatedOutput: entry.aggregatedOutput ?? entry.outputDelta ?? "",
            exitCode: entry.exitCode, durationMs: entry.durationMs,
          }
          commandExecutions.set(entry.itemId, command)
          messages.push(command)
        }
        break
      }
      case "file_change": {
        const existing = fileChanges.get(entry.itemId)
        if (existing) {
          existing.status = entry.status
          if (entry.changes) existing.changes = entry.changes
          if (entry.outputDelta) existing.output += entry.outputDelta
        } else {
          const fileChange = {
            ...createBaseMessage(entry), kind: "file_change" as const, itemId: entry.itemId,
            status: entry.status, changes: entry.changes ?? [], output: entry.outputDelta ?? "",
          }
          fileChanges.set(entry.itemId, fileChange)
          messages.push(fileChange)
        }
        break
      }
      case "turn_plan": {
        const existing = turnPlans.get(entry.turnId)
        if (existing) {
          existing.explanation = entry.explanation
          existing.plan = entry.plan
        } else {
          const plan = { ...createBaseMessage(entry), kind: "turn_plan" as const, turnId: entry.turnId, explanation: entry.explanation, plan: entry.plan }
          turnPlans.set(entry.turnId, plan)
          messages.push(plan)
        }
        break
      }
      case "proposed_plan": {
        const existing = proposedPlans.get(entry.turnId)
        if (existing) {
          existing.plan = entry.plan
        } else {
          const plan = { ...createBaseMessage(entry), kind: "proposed_plan" as const, turnId: entry.turnId, plan: entry.plan }
          proposedPlans.set(entry.turnId, plan)
          messages.push(plan)
        }
        break
      }
      case "turn_activity": {
        const key = entry.turnId || "active"
        const existing = turnActivities.get(key)
        if (existing) existing.activity = entry.activity
        else {
          const activity = { ...createBaseMessage(entry), kind: "turn_activity" as const, turnId: entry.turnId, activity: entry.activity }
          turnActivities.set(key, activity)
          messages.push(activity)
        }
        break
      }
      case "model_change":
        messages.push({
          ...createBaseMessage(entry),
          kind: "model_change",
          model: entry.model,
          reasoningEffort: entry.reasoningEffort,
        })
        break
      case "context_window_updated":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_window_updated",
          usage: entry.usage,
        })
        break
      case "rate_limit_updated":
        messages.push({
          ...createBaseMessage(entry),
          kind: "rate_limit_updated",
          rateLimits: entry.rateLimits,
        })
        break
      case "compact_boundary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_boundary",
        })
        break
      case "compact_summary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_summary",
          summary: entry.summary,
        })
        break
      case "context_cleared":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_cleared",
        })
        break
      case "interrupted":
        messages.push({
          ...createBaseMessage(entry),
          kind: "interrupted",
        })
        break
      default:
        messages.push({
          ...createBaseMessage(entry),
          kind: "unknown",
          json: JSON.stringify(entry, null, 2),
        })
        break
    }
  }

  return messages
}

export function extractInternalSystemPayload(content: string) {
	// Codex persists repository bootstrap instructions as a user-prompt in a
	// few app-server versions. They are machine context, not something the user
	// typed, so preserve them as a collapsible payload instead of a chat bubble.
	const agentsBootstrap = content.match(/^#\s+AGENTS\.md instructions\b[\s\S]*?(?:<\/INSTRUCTIONS>|<\/environment_context>)(?:\s*<environment_context>[\s\S]*?<\/environment_context>)?/i)
	if (agentsBootstrap) {
		const payload = agentsBootstrap[0].trim()
		return {
			kind: "agents_instructions",
			payload,
			dedupeKey: `agents_instructions:${payload.replace(/\s+/g, " ")}`,
		}
	}

	const standaloneInstructions = content.match(/<INSTRUCTIONS>\s*[\s\S]*?\s*<\/INSTRUCTIONS>/i)
	if (standaloneInstructions) {
		const payload = standaloneInstructions[0].trim()
		return {
			kind: "agents_instructions",
			payload,
			dedupeKey: `agents_instructions:${payload.replace(/\s+/g, " ")}`,
		}
	}

	const match = content.match(/<(environment_context|turn_aborted)>\s*([\s\S]*?)\s*<\/\1>/i)
  if (match) {
    const kind = match[1]!.toLowerCase()
    const payload = match[0].trim()
    return {
      kind,
      payload,
      dedupeKey: `${kind}:${payload.replace(/\s+/g, " ")}`,
    }
  }

	return null
}

/** Removes machine-only response metadata that must never become chat content. */
export function stripInternalAssistantMetadata(content: string) {
  return content.replace(/(?:\r?\n)*<oai-mem-citation>\s*[\s\S]*?<\/oai-mem-citation>\s*$/i, "").trimEnd()
}
