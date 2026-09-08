import { describe, expect, test } from "bun:test"
import { extractInternalSystemPayload, processTranscriptMessages, stripInternalAssistantMetadata, tmuxCaptureToReadableText, tmuxCaptureToTranscriptMessages } from "./parseTranscript"
import { getLatestToolIds } from "../app/derived"
import type { TranscriptEntry } from "../../shared/types"

function entry(partial: Omit<TranscriptEntry, "_id" | "createdAt">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...partial,
  } as TranscriptEntry
}

describe("processTranscriptMessages", () => {
  test("removes internal memory citations from assistant bubbles", () => {
    const metadata = "<oai-mem-citation>\n<citation_entries>MEMORY.md:1-2</citation_entries>\n<rollout_ids>abc</rollout_ids>\n</oai-mem-citation>"
    const messages = processTranscriptMessages([
      entry({ kind: "assistant_text", text: `پاسخ قابل نمایش.\n\n${metadata}` }),
      entry({ kind: "assistant_text", text: metadata }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind === "assistant_text" ? messages[0].text : "").toBe("پاسخ قابل نمایش.")
    expect(stripInternalAssistantMetadata(`normal mention: <oai-mem-citation>`)).toBe("normal mention: <oai-mem-citation>")
  })

  test("merges native Codex command deltas, file changes, plans, and activity", () => {
    const messages = processTranscriptMessages([
      entry({ kind: "command_execution", itemId: "cmd-1", command: "go test ./...", cwd: "/work", status: "inProgress" }),
      entry({ kind: "command_execution", itemId: "cmd-1", status: "inProgress", outputDelta: "ok one\n" }),
      entry({ kind: "command_execution", itemId: "cmd-1", command: "go test ./...", cwd: "/work", status: "completed", aggregatedOutput: "ok all\n", exitCode: 0 }),
      entry({ kind: "file_change", itemId: "file-1", status: "completed", changes: [{ path: "main.go", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }] }),
      entry({ kind: "turn_plan", turnId: "turn-1", explanation: "Implement safely", plan: [{ step: "Test", status: "inProgress" }] }),
      entry({ kind: "turn_activity", turnId: "turn-1", activity: "thinking" }),
      entry({ kind: "turn_activity", turnId: "turn-1", activity: "writing_response" }),
    ])
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ kind: "command_execution", status: "completed", aggregatedOutput: "ok all\n", exitCode: 0 })
    expect(messages[1]).toMatchObject({ kind: "file_change", changes: [{ path: "main.go" }] })
    expect(messages[2]).toMatchObject({ kind: "turn_plan", explanation: "Implement safely" })
    expect(messages[3]).toMatchObject({ kind: "turn_activity", activity: "writing_response" })
  })

  test("streams one Codex assistant bubble from app-server deltas", () => {
    const messages = processTranscriptMessages([
      entry({ kind: "assistant_text", itemId: "msg-1", textDelta: "در حال ", status: "inProgress" }),
      entry({ kind: "assistant_text", itemId: "msg-1", textDelta: "بررسی", status: "inProgress" }),
      entry({ kind: "assistant_text", itemId: "msg-1", text: "بررسی تمام شد", status: "completed" }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: "assistant_text",
      itemId: "msg-1",
      text: "بررسی تمام شد",
      status: "completed",
    })
  })

  test("deduplicates native and wrapped proposed-plan records by turn", () => {
    const messages = processTranscriptMessages([
      entry({ kind: "proposed_plan", turnId: "turn-1", plan: "# Initial plan" }),
      entry({ kind: "proposed_plan", turnId: "turn-1", plan: "# Final plan\n\n- Test" }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: "proposed_plan", turnId: "turn-1", plan: "# Final plan\n\n- Test" })
  })

  test("splits tmux capture entries into readable chat messages", () => {
    const messages = processTranscriptMessages([
      {
        _id: "tmux-capture-chat-1",
        createdAt: Date.now(),
        kind: "assistant_text",
        text: "\u001b[32m╭────╮\u001b[0m\n│ سلام از tmux │\n│ npm test │\n╰────╯\n\n› دوباره تست کن\n\n• انجام شد\n\n",
      },
    ])

    expect(messages).toHaveLength(3)
    expect(messages[0]?.kind).toBe("assistant_text")
    expect(messages[1]?.kind).toBe("user_prompt")
    expect(messages[2]?.kind).toBe("assistant_text")
    if (messages[0]?.kind !== "assistant_text" || messages[1]?.kind !== "user_prompt" || messages[2]?.kind !== "assistant_text") {
      throw new Error("unexpected message")
    }
    expect(messages[0].text).toBe("سلام از tmux\n\n```shell\nnpm test\n```")
    expect(messages[1].content).toBe("دوباره تست کن")
    expect(messages[2].text).toBe("انجام شد")
  })

  test("splits Claude and Gemini tmux prompts without Codex-only assumptions", () => {
    const messages = processTranscriptMessages([
      {
        _id: "tmux-capture-chat-2",
        createdAt: Date.now(),
        kind: "assistant_text",
        text: [
          "Claude Sonnet - /tmp/project - tokens 120k",
          "> review this file",
          "I'll review it now.",
          "Gemini 3 Pro - /tmp/project - model ready",
          "❯ summarize the diff",
          "Summary is ready.",
        ].join("\n"),
      },
    ])

    expect(messages.map((message) => message.kind)).toEqual(["user_prompt", "assistant_text", "user_prompt", "assistant_text"])
    expect(messages[0]?.kind === "user_prompt" ? messages[0].content : "").toBe("review this file")
    expect(messages[2]?.kind === "user_prompt" ? messages[2].content : "").toBe("summarize the diff")
  })

  test("hydrates tool results onto prior tool calls", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "pwd" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: "/Users/jake/Projects/abolqasem\n",
      }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toBe("/Users/jake/Projects/abolqasem\n")
  })

  test("hydrates ask-user-question results with typed answers", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-2",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  test("hydrates discarded prompt tool results", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-3",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { discarded: true },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ discarded: true })
  })

  test("preserves attachments on hydrated user prompts", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "user_prompt",
        content: "Please inspect these.",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec.pdf",
          absolutePath: "/tmp/project/.abolqasem/uploads/spec.pdf",
          relativePath: "./.abolqasem/uploads/spec.pdf",
          contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
          mimeType: "application/pdf",
          size: 1234,
        }],
      }),
    ])

    expect(messages[0]?.kind).toBe("user_prompt")
    if (messages[0]?.kind !== "user_prompt") throw new Error("unexpected message")
    expect(messages[0].attachments).toHaveLength(1)
    expect(messages[0].attachments?.[0]?.relativePath).toBe("./.abolqasem/uploads/spec.pdf")
  })

  test("preserves context window update entries", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "context_window_updated",
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          compactsAutomatically: true,
        },
      }),
    ])

    expect(messages[0]?.kind).toBe("context_window_updated")
    if (messages[0]?.kind !== "context_window_updated") throw new Error("unexpected message")
    expect(messages[0].usage.maxTokens).toBe(258_400)
    expect(messages[0].usage.compactsAutomatically).toBe(true)
  })

  test("preserves rate limit update entries", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "rate_limit_updated",
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 30, windowDurationMins: 300 },
          secondary: { usedPercent: 40, windowDurationMins: 10080 },
        },
        hidden: true,
      }),
    ])

    expect(messages[0]?.kind).toBe("rate_limit_updated")
    if (messages[0]?.kind !== "rate_limit_updated") throw new Error("unexpected message")
    expect(messages[0].rateLimits.primary?.usedPercent).toBe(30)
    expect(messages[0].hidden).toBe(true)
  })

  test("preserves machine-generated environment context prompts for collapsed rendering", () => {
    const messages = processTranscriptMessages([
      entry({ kind: "user_prompt", content: "<environment_context>\n<timezone>Asia/Tehran</timezone>\n</environment_context>", attachments: [] }),
      entry({ kind: "user_prompt", content: "environment_context یعنی چه؟", attachments: [] }),
    ])

    expect(messages).toHaveLength(2)
    expect(messages[0]?.kind).toBe("user_prompt")
    if (messages[0]?.kind !== "user_prompt") throw new Error("unexpected message")
    expect(messages[0].content).toContain("<environment_context>")
    expect(messages[1]?.kind).toBe("user_prompt")
    if (messages[1]?.kind !== "user_prompt") throw new Error("unexpected message")
    expect(messages[1].content).toBe("environment_context یعنی چه؟")
  })

  test("deduplicates repeated internal system payloads while retaining one collapsed record", () => {
    const content = "<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>"
    const messages = processTranscriptMessages([
      entry({ kind: "user_prompt", content, attachments: [] }),
      entry({ kind: "user_prompt", content: `context before\n${content}\ncontext after`, attachments: [] }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: "user_prompt", content })
  })

  test("extracts standalone instructions as a collapsed internal payload", () => {
    const content = "<INSTRUCTIONS>\nRun tests before committing.\n</INSTRUCTIONS>\n\nپیام واقعی"
    const payload = extractInternalSystemPayload(content)
    expect(payload?.kind).toBe("agents_instructions")
    expect(payload?.payload).toContain("Run tests")
  })

  test("deduplicates turn-aborted assistant echoes", () => {
    const payload = "<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>"
    const messages = processTranscriptMessages([
      { _id: "abort-user", kind: "user_prompt", content: payload, attachments: [], createdAt: 1 },
      { _id: "abort-echo", kind: "assistant_text", text: payload, createdAt: 2 },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("user_prompt")
  })

  test("preserves structured Claude ask-user-question results when a later echoed tool result arrives", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-3",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: "User has answered your questions: \"Provider?\"=\"Codex\".",
        debugRaw: JSON.stringify({
          type: "user",
          tool_use_result: {
            questions: [{ question: "Provider?" }],
            answers: { "Provider?": "Codex" },
          },
        }),
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })
})

describe("tmuxCaptureToReadableText", () => {
  test("strips ansi control sequences and repeated blank lines", () => {
    expect(tmuxCaptureToReadableText("one\u001b[31m\n\n\n\u001b[0mtwo")).toBe("one\n\ntwo")
  })

  test("does not turn CLI help option rows into code blocks", () => {
    const text = tmuxCaptureToReadableText([
      "Options:",
      "  --model <model>                  Model for the current session",
      "  --permission-mode <mode>         Permission mode to use for the session",
      "Commands:",
      "  mcp                              Configure and manage MCP servers",
    ].join("\n"))

    expect(text).toContain("--model <model>")
    expect(text).not.toContain("```")
  })

  test("keeps multiline shell commands in one shell block", () => {
    const text = tmuxCaptureToReadableText([
      'curl -sS "http://154.59.156.39:36631/get_model_info" \\',
      '  -H "Authorization: Bearer YOUR_API_KEY" \\',
      '  -H "Content-Type: application/json" | jq .',
    ].join("\n"))

    expect(text).toBe([
      "```shell",
      'curl -sS "http://154.59.156.39:36631/get_model_info" \\',
      '  -H "Authorization: Bearer YOUR_API_KEY" \\',
      '  -H "Content-Type: application/json" | jq .',
      "```",
    ].join("\n"))
  })

  test("does not merge prose after a completed shell command", () => {
    const text = tmuxCaptureToReadableText([
      'curl -sS "http://example.test"',
      "توضیح بعد از فرمان",
    ].join("\n"))

    expect(text).toBe([
      "```shell",
      'curl -sS "http://example.test"',
      "```",
      "",
      "توضیح بعد از فرمان",
    ].join("\n"))
  })
})

describe("tmuxCaptureToTranscriptMessages", () => {
  test("keeps terminal warnings in a highlighted code block", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-1",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: "⚠ MCP startup incomplete\n\n› سلام\n",
    })

    expect(messages[0]?.kind).toBe("assistant_text")
    if (messages[0]?.kind !== "assistant_text") throw new Error("unexpected message")
    expect(messages[0].text).toBe("```text\n⚠ MCP startup incomplete\n```")
  })

  test("ignores the active trailing composer prompt", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-2",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: [
        "• قبلی انجام شد.",
        "",
        "› Run /review on my current changes",
      ].join("\n"),
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("assistant_text")
    if (messages[0]?.kind !== "assistant_text") throw new Error("unexpected message")
    expect(messages[0].text).toBe("قبلی انجام شد.")
  })

  test("keeps prompts that are followed by real assistant output", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-3",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: [
        "› review this diff",
        "I am reviewing it now.",
      ].join("\n"),
    })

    expect(messages.map((message) => message.kind)).toEqual(["user_prompt", "assistant_text"])
    expect(messages[0]?.kind === "user_prompt" ? messages[0].content : "").toBe("review this diff")
  })

  test("keeps multiline tmux prompts as user messages", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-4",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: [
        "› خط اول پیام من",
        "بببب",
        "ادامه پیام",
        "Working (2s • esc to interrupt)",
        "• پاسخ آماده شد.",
      ].join("\n"),
    })

    expect(messages.map((message) => message.kind)).toEqual(["user_prompt", "assistant_text"])
    expect(messages[0]?.kind === "user_prompt" ? messages[0].content : "").toBe("خط اول پیام من\nبببب\nادامه پیام")
    expect(messages[1]?.kind === "assistant_text" ? messages[1].text : "").toBe("پاسخ آماده شد.")
  })

  test("filters tmux working status from assistant text", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-5",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: [
        "Working (43s • esc to interrupt)",
        "• انجام شد.",
      ].join("\n"),
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind === "assistant_text" ? messages[0].text : "").toBe("انجام شد.")
  })

  test("preserves mermaid tmux blocks for diagram rendering", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-6",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: [
        "• نمودار:",
        "graph TD",
        "    A[Web] --> B[tmux]",
        "    B --> C[Agent]",
      ].join("\n"),
    })

    expect(messages[0]?.kind).toBe("assistant_text")
    if (messages[0]?.kind !== "assistant_text") throw new Error("unexpected message")
    expect(messages[0].text).toContain("```mermaid\ngraph TD")
  })

  test("keeps RTL mermaid labels inside the diagram block", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-6-rtl-mermaid",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: [
        "• flowchart TD",
        "  A[شروع] --> B{ورودی معتبر است؟}",
        "  B -- بله --> C[پردازش داده]",
        "  B -- خیر --> D[نمایش خطا]",
      ].join("\n"),
    })

    expect(messages[0]?.kind).toBe("assistant_text")
    if (messages[0]?.kind !== "assistant_text") throw new Error("unexpected message")
    expect(messages[0].text).toContain("```mermaid\nflowchart TD")
    expect(messages[0].text).toContain("B -- خیر --> D[نمایش خطا]\n```")
    expect(messages[0].text).not.toContain("```text")
  })

  test("does not render a lone mermaid start line as an empty diagram", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-6-empty-mermaid",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: "• flowchart TD",
    })

    expect(messages[0]?.kind).toBe("assistant_text")
    if (messages[0]?.kind !== "assistant_text") throw new Error("unexpected message")
    expect(messages[0].text).toBe("flowchart TD")
  })

  test("preserves tmux code blocks for syntax highlighting", () => {
    const messages = tmuxCaptureToTranscriptMessages({
      _id: "tmux-capture-chat-7",
      createdAt: Date.now(),
      kind: "assistant_text",
      text: [
        "• این بخش کد PHP است:",
        "Timer::tick(5000, function () {",
        "    // every 5 seconds",
        "});",
        "",
        "$this->workerTickers = [",
        "    new \\EitaaView\\Worker\\PoolStatsTicker($this),",
        "    new \\EitaaView\\Worker\\RedisTopologyTicker($this),",
        "];",
      ].join("\n"),
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("assistant_text")
    if (messages[0]?.kind !== "assistant_text") throw new Error("unexpected message")
    expect(messages[0].text).toContain("```php\nTimer::tick")
    expect(messages[0].text).toContain("```php\n$this->workerTickers")
  })
})

describe("getLatestToolIds", () => {
  test("returns the latest unresolved special tool ids", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "tool-2",
          input: {
            todos: [{ content: "Implement adapter", status: "in_progress", activeForm: "Implementing adapter" }],
          },
        },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      ApprovalRequest: null,
      AskUserQuestion: messages[0]?.kind === "tool" ? messages[0].id : null,
      ExitPlanMode: null,
      TodoWrite: messages[1]?.kind === "tool" ? messages[1].id : null,
    })
  })

  test("ignores discarded special tools when choosing the latest active id", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: { discarded: true, answers: {} },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-2",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { discarded: true },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      ApprovalRequest: null,
      AskUserQuestion: null,
      ExitPlanMode: null,
      TodoWrite: null,
    })
  })
})
