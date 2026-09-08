import { describe, expect, test } from "bun:test"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { getProcessingStatus } from "./processingStatus"

function message(value: Partial<HydratedTranscriptMessage> & Pick<HydratedTranscriptMessage, "kind">): HydratedTranscriptMessage {
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...value } as HydratedTranscriptMessage
}

describe("getProcessingStatus", () => {
  test("uses Thinking instead of the transport-level starting status", () => {
    expect(getProcessingStatus([], "starting")).toBe("thinking")
  })

  test("ignores activity from a completed previous turn", () => {
    expect(getProcessingStatus([
      message({ kind: "turn_activity", activity: "writing_response" }),
      message({ kind: "result", success: true, cancelled: false, result: "", durationMs: 0 }),
      message({ kind: "user_prompt", content: "next request", attachments: [] }),
    ], "running")).toBe("thinking")
  })

  test("shows the latest real app-server activity for the active turn", () => {
    expect(getProcessingStatus([
      message({ kind: "user_prompt", content: "run tests", attachments: [] }),
      message({ kind: "turn_activity", activity: "thinking" }),
      message({ kind: "turn_activity", activity: "running_command" }),
    ], "running")).toBe("running_command")
  })

  test("derives running command activity from a native in-progress command", () => {
    expect(getProcessingStatus([
      message({ kind: "user_prompt", content: "run tests", attachments: [] }),
      message({ kind: "command_execution", itemId: "cmd-1", command: "go test ./...", cwd: ".", status: "inProgress", aggregatedOutput: "" }),
    ], "running")).toBe("running_command")
  })

  test("derives applying changes activity from a native in-progress file change", () => {
    expect(getProcessingStatus([
      message({ kind: "user_prompt", content: "edit file", attachments: [] }),
      message({ kind: "file_change", itemId: "file-1", status: "inProgress", changes: [], output: "" }),
    ], "running")).toBe("applying_changes")
  })

  test("shows MCP activity while a native MCP tool is running", () => {
    expect(getProcessingStatus([
      message({ kind: "user_prompt", content: "search docs", attachments: [] }),
      message({ kind: "turn_activity", activity: "running_mcp_tool" }),
    ], "running")).toBe("running_mcp_tool")
  })

  test("shows writing activity while an app-server message is streaming", () => {
    expect(getProcessingStatus([
      message({ kind: "user_prompt", content: "status", attachments: [] }),
      message({ kind: "assistant_text", text: "working", itemId: "msg-1", status: "inProgress" }),
    ], "running")).toBe("writing_response")
  })

  test("keeps the explicit waiting-for-user state", () => {
    expect(getProcessingStatus([], "waiting_for_user")).toBe("waiting_for_user")
  })
})
