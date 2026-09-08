package codex

import (
	"encoding/json"
	"fmt"

	codexrpc "abolqasem/internal/providers/codex/rpc"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

type HarnessEvent struct {
	Type         string                     `json:"type"`
	SessionToken string                     `json:"sessionToken,omitempty"`
	Entry        readmodels.TranscriptEntry `json:"entry,omitempty"`
}

type StreamNormalizer struct{}

func NewStreamNormalizer() *StreamNormalizer {
	return &StreamNormalizer{}
}

func (n *StreamNormalizer) HandleNotification(notification codexrpc.Notification) []HarnessEvent {
	switch notification.Method {
	case "thread/started":
		var params struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		if decodeParams(notification.Params, &params) != nil || params.Thread.ID == "" {
			return nil
		}
		return []HarnessEvent{{Type: "session_token", SessionToken: params.Thread.ID}}
	case "thread/tokenUsage/updated":
		entry := contextWindowEntry(notification.Params)
		if entry == nil {
			return nil
		}
		return []HarnessEvent{{Type: "transcript", Entry: entry}}
	case "account/rateLimits/updated":
		entry := rateLimitEntry(notification.Params)
		if entry == nil {
			return nil
		}
		return []HarnessEvent{{Type: "transcript", Entry: entry}}
	case "thread/compacted":
		return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindCompactBoundary, nil)}}
	case "turn/started":
		events := activityEvents(notification.Params, "thinking")
		var params struct {
			Model           string `json:"model"`
			Effort          string `json:"effort"`
			ReasoningEffort string `json:"reasoning_effort"`
			Collaboration   struct {
				Settings struct {
					Model           string `json:"model"`
					ReasoningEffort string `json:"reasoning_effort"`
				} `json:"settings"`
			} `json:"collaborationMode"`
			CollaborationSnake struct {
				Settings struct {
					Model           string `json:"model"`
					ReasoningEffort string `json:"reasoning_effort"`
				} `json:"settings"`
			} `json:"collaboration_mode"`
		}
		if decodeParams(notification.Params, &params) == nil {
			effort := params.Effort
			if effort == "" {
				effort = params.ReasoningEffort
			}
			if params.Model == "" {
				params.Model = params.Collaboration.Settings.Model
			}
			if params.Model == "" {
				params.Model = params.CollaborationSnake.Settings.Model
			}
			if effort == "" {
				effort = params.Collaboration.Settings.ReasoningEffort
			}
			if effort == "" {
				effort = params.CollaborationSnake.Settings.ReasoningEffort
			}
			if params.Model == "" && effort == "" {
				return events
			}
			events = append(events, HarnessEvent{Type: "transcript", Entry: transcript.New(transcript.KindModelChange, map[string]any{"model": params.Model, "reasoningEffort": effort})})
		}
		return events
	case "turn/plan/updated":
		return turnPlanEvents(notification.Params)
	case "item/commandExecution/outputDelta":
		return commandOutputDeltaEvents(notification.Params)
	case "item/agentMessage/delta":
		return agentMessageDeltaEvents(notification.Params)
	case "item/fileChange/outputDelta":
		return fileChangeDeltaEvents(notification.Params)
	case "item/started":
		return itemStartedEvents(notification.Params)
	case "item/completed":
		return itemCompletedEvents(notification.Params)
	case "turn/completed":
		return []HarnessEvent{{Type: "transcript", Entry: turnCompletedEntry(notification.Params)}}
	default:
		return nil
	}
}

func itemStartedEvents(raw json.RawMessage) []HarnessEvent {
	var params struct {
		Item map[string]any `json:"item"`
	}
	if decodeParams(raw, &params) != nil || params.Item == nil {
		return nil
	}
	switch asString(params.Item["type"]) {
	case "plan":
		return planItemEvents(params.Item)
	case "mcpToolCall", "mcp_tool_call":
		return mcpToolCallStartedEvents(params.Item)
	case "commandExecution":
		command := asString(params.Item["command"])
		if command == "" {
			return nil
		}
		return []HarnessEvent{
			{Type: "transcript", Entry: transcript.New(transcript.KindCommandExecution, commandExecutionFields(params.Item))},
			{Type: "transcript", Entry: transcript.New(transcript.KindTurnActivity, map[string]any{"activity": "running_command"})},
		}
	case "fileChange":
		return []HarnessEvent{
			{Type: "transcript", Entry: transcript.New(transcript.KindFileChange, fileChangeFields(params.Item))},
			{Type: "transcript", Entry: transcript.New(transcript.KindTurnActivity, map[string]any{"activity": "applying_changes"})},
		}
	case "reasoning":
		return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindTurnActivity, map[string]any{"activity": "thinking"})}}
	case "agentMessage":
		return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindTurnActivity, map[string]any{"activity": "writing_response"})}}
	default:
		return nil
	}
}

func planItemEvents(item map[string]any) []HarnessEvent {
	text := firstStringValue(item, "text", "plan", "content", "summary")
	if text == "" {
		return nil
	}
	return []HarnessEvent{{
		Type: "transcript",
		Entry: transcript.New(transcript.KindToolCall, map[string]any{"tool": map[string]any{
			"kind":     "tool",
			"toolKind": "exit_plan_mode",
			"toolName": "Plan",
			"toolId":   asString(item["id"]),
			"input":    map[string]any{"plan": text},
		}}),
	}}
}

func itemCompletedEvents(raw json.RawMessage) []HarnessEvent {
	var params struct {
		Item map[string]any `json:"item"`
	}
	if decodeParams(raw, &params) != nil || params.Item == nil {
		return nil
	}
	switch asString(params.Item["type"]) {
	case "plan":
		return planItemEvents(params.Item)
	case "mcpToolCall", "mcp_tool_call":
		return mcpToolCallCompletedEvents(params.Item)
	case "agentMessage":
		text := asString(params.Item["text"])
		if text == "" {
			return nil
		}
		return []HarnessEvent{{
			Type: "transcript",
			Entry: transcript.New(transcript.KindAssistantText, map[string]any{
				"itemId": asString(params.Item["id"]),
				"text":   text,
				"status": "completed",
			}),
		}}
	case "commandExecution":
		return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindCommandExecution, commandExecutionFields(params.Item))}}
	case "fileChange":
		return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindFileChange, fileChangeFields(params.Item))}}
	default:
		return nil
	}
}

// Codex app-server exposes MCP invocations as native items. Keep them as
// regular tool calls in the transcript so the web client renders the same
// expandable tool card used by Claude and other providers.
func mcpToolCallStartedEvents(item map[string]any) []HarnessEvent {
	toolCall := mcpToolCallEntry(item)
	if toolCall == nil {
		return nil
	}
	return []HarnessEvent{
		{Type: "transcript", Entry: toolCall},
		{Type: "transcript", Entry: transcript.New(transcript.KindTurnActivity, map[string]any{"activity": "running_mcp_tool"})},
	}
}

func mcpToolCallCompletedEvents(item map[string]any) []HarnessEvent {
	itemID := asString(item["id"])
	if itemID == "" {
		return nil
	}

	result := firstNonNil(item["result"], item["output"], item["content"])
	status := firstStringValue(item, "status")
	errorValue := firstNonNil(item["error"], item["failure"])
	isError := status == "failed" || status == "error" || errorValue != nil
	if result == nil && errorValue != nil {
		result = errorValue
	}
	return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindToolResult, map[string]any{
		"toolId":  itemID,
		"content": result,
		"isError": isError,
	})}}
}

func mcpToolCallEntry(item map[string]any) readmodels.TranscriptEntry {
	itemID := asString(item["id"])
	server := firstStringValue(item, "server", "serverName", "server_name")
	tool := firstStringValue(item, "tool", "toolName", "tool_name")
	if itemID == "" || tool == "" {
		return nil
	}
	arguments := firstNonNil(item["arguments"], item["input"], item["params"])
	if arguments == nil {
		arguments = map[string]any{}
	}
	return transcript.New(transcript.KindToolCall, map[string]any{
		"tool": map[string]any{
			"kind":     "tool",
			"toolKind": "mcp_generic",
			"toolName": "mcp__" + server + "__" + tool,
			"toolId":   itemID,
			"input": map[string]any{
				"server":  server,
				"tool":    tool,
				"payload": arguments,
			},
		},
	})
}

func commandExecutionFields(item map[string]any) map[string]any {
	return map[string]any{
		"itemId": asString(item["id"]), "command": asString(item["command"]),
		"cwd": asString(item["cwd"]), "status": asString(item["status"]),
		"aggregatedOutput": asString(item["aggregatedOutput"]), "exitCode": item["exitCode"],
		"durationMs": item["durationMs"],
	}
}

func fileChangeFields(item map[string]any) map[string]any {
	return map[string]any{
		"itemId": asString(item["id"]), "status": asString(item["status"]), "changes": item["changes"],
	}
}

func activityEvents(raw json.RawMessage, activity string) []HarnessEvent {
	var params struct {
		TurnID string `json:"turnId"`
	}
	_ = decodeParams(raw, &params)
	return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindTurnActivity, map[string]any{"turnId": params.TurnID, "activity": activity})}}
}

func commandOutputDeltaEvents(raw json.RawMessage) []HarnessEvent {
	var params struct {
		ItemID string `json:"itemId"`
		Delta  string `json:"delta"`
	}
	if decodeParams(raw, &params) != nil || params.ItemID == "" || params.Delta == "" {
		return nil
	}
	return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindCommandExecution, map[string]any{"itemId": params.ItemID, "outputDelta": params.Delta, "status": "inProgress"})}}
}

func agentMessageDeltaEvents(raw json.RawMessage) []HarnessEvent {
	var params struct {
		ItemID string `json:"itemId"`
		Delta  string `json:"delta"`
	}
	if decodeParams(raw, &params) != nil || params.ItemID == "" || params.Delta == "" {
		return nil
	}
	return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindAssistantText, map[string]any{
		"itemId":    params.ItemID,
		"textDelta": params.Delta,
		"status":    "inProgress",
	})}}
}

func fileChangeDeltaEvents(raw json.RawMessage) []HarnessEvent {
	var params struct {
		ItemID string `json:"itemId"`
		Delta  string `json:"delta"`
	}
	if decodeParams(raw, &params) != nil || params.ItemID == "" || params.Delta == "" {
		return nil
	}
	return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindFileChange, map[string]any{"itemId": params.ItemID, "outputDelta": params.Delta, "status": "inProgress"})}}
}

func turnPlanEvents(raw json.RawMessage) []HarnessEvent {
	var params struct {
		TurnID      string           `json:"turnId"`
		Explanation *string          `json:"explanation"`
		Plan        []map[string]any `json:"plan"`
	}
	if decodeParams(raw, &params) != nil || params.TurnID == "" {
		return nil
	}
	return []HarnessEvent{{Type: "transcript", Entry: transcript.New(transcript.KindTurnPlan, map[string]any{
		"turnId": params.TurnID, "explanation": params.Explanation, "plan": params.Plan,
	})}}
}

func turnCompletedEntry(raw json.RawMessage) readmodels.TranscriptEntry {
	var params struct {
		Turn struct {
			Status string `json:"status"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
	}
	_ = decodeParams(raw, &params)

	isCancelled := params.Turn.Status == "interrupted"
	isError := params.Turn.Status == "failed"
	result := ""
	if params.Turn.Error != nil {
		result = params.Turn.Error.Message
	}
	subtype := "success"
	if isCancelled {
		subtype = "cancelled"
	} else if isError {
		subtype = "error"
	}
	return transcript.New(transcript.KindResult, map[string]any{
		"subtype":    subtype,
		"isError":    isError,
		"durationMs": float64(0),
		"result":     result,
	})
}

func contextWindowEntry(raw json.RawMessage) readmodels.TranscriptEntry {
	var params struct {
		TokenUsage map[string]any `json:"tokenUsage"`
	}
	if decodeParams(raw, &params) != nil || params.TokenUsage == nil {
		return nil
	}
	total := asMap(firstNonNil(params.TokenUsage["total"], params.TokenUsage["total_token_usage"]))
	last := asMap(firstNonNil(params.TokenUsage["last"], params.TokenUsage["last_token_usage"]))
	usedTokens := tokenValue(last, "totalTokens", "total_tokens")
	return transcript.New(transcript.KindContextWindowUpdated, map[string]any{
		"usage": map[string]any{
			"usedTokens":            usedTokens,
			"totalProcessedTokens":  tokenValue(total, "totalTokens", "total_tokens"),
			"maxTokens":             tokenValue(params.TokenUsage, "modelContextWindow", "model_context_window"),
			"inputTokens":           tokenValue(last, "inputTokens", "input_tokens"),
			"cachedInputTokens":     tokenValue(last, "cachedInputTokens", "cached_input_tokens"),
			"outputTokens":          tokenValue(last, "outputTokens", "output_tokens"),
			"reasoningOutputTokens": tokenValue(last, "reasoningOutputTokens", "reasoning_output_tokens"),
			"lastUsedTokens":        usedTokens,
			"compactsAutomatically": true,
		},
	})
}

func rateLimitEntry(raw json.RawMessage) readmodels.TranscriptEntry {
	var params struct {
		RateLimits map[string]any `json:"rateLimits"`
	}
	if decodeParams(raw, &params) != nil || params.RateLimits == nil {
		return nil
	}
	snapshot := normalizeRateLimitSnapshot(params.RateLimits)
	if snapshot == nil {
		return nil
	}
	return transcript.New(transcript.KindRateLimitUpdated, map[string]any{
		"rateLimits": snapshot,
	})
}

func normalizeRateLimitSnapshot(raw map[string]any) map[string]any {
	primary := normalizeRateLimitWindow(asMap(firstNonNil(raw["primary"])))
	secondary := normalizeRateLimitWindow(asMap(firstNonNil(raw["secondary"])))
	windows := normalizeRateLimitWindows(raw, primary, secondary)
	if len(windows) == 0 {
		return nil
	}
	return map[string]any{
		"limitId":              firstStringValue(raw, "limitId", "limit_id"),
		"limitName":            firstStringValue(raw, "limitName", "limit_name"),
		"primary":              primary,
		"secondary":            secondary,
		"windows":              windows,
		"credits":              normalizeRateLimitCredits(asMap(firstNonNil(raw["credits"]))),
		"planType":             firstStringValue(raw, "planType", "plan_type"),
		"rateLimitReachedType": firstStringValue(raw, "rateLimitReachedType", "rate_limit_reached_type"),
	}
}

// Newer app-server builds may attach an explicit list of rolling windows while
// older ones expose only primary/secondary. Preserve both shapes so a 5-hour
// window can appear or disappear without a client update.
func normalizeRateLimitWindows(raw map[string]any, primary, secondary map[string]any) []map[string]any {
	result := make([]map[string]any, 0, 4)
	seen := map[string]bool{}
	appendWindow := func(candidate map[string]any) {
		if candidate == nil {
			return
		}
		key := fmt.Sprintf("%v:%v:%v", candidate["windowDurationMins"], candidate["resetsAt"], candidate["usedPercent"])
		if seen[key] {
			return
		}
		seen[key] = true
		result = append(result, candidate)
	}
	appendWindow(primary)
	appendWindow(secondary)
	for _, key := range []string{"windows", "rateLimitWindows", "rate_limit_windows"} {
		items, ok := raw[key].([]any)
		if !ok {
			continue
		}
		for _, item := range items {
			appendWindow(normalizeRateLimitWindow(asMap(item)))
		}
	}
	return result
}

func normalizeRateLimitCredits(raw map[string]any) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	result := map[string]any{}
	if value, ok := raw["hasCredits"].(bool); ok {
		result["hasCredits"] = value
	} else if value, ok := raw["has_credits"].(bool); ok {
		result["hasCredits"] = value
	}
	if value, ok := raw["unlimited"].(bool); ok {
		result["unlimited"] = value
	}
	balance := firstStringValue(raw, "balance")
	if balance != "" {
		result["balance"] = balance
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func normalizeRateLimitWindow(raw map[string]any) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	usedPercent, ok := firstNumberValue(raw, "usedPercent", "used_percent")
	if !ok {
		return nil
	}
	windowDurationMins, hasWindowDuration := firstNumberValue(raw, "windowDurationMins", "window_minutes")
	resetsAt, hasResetsAt := firstNumberValue(raw, "resetsAt", "resets_at")
	result := map[string]any{
		"usedPercent": usedPercent,
	}
	if hasWindowDuration {
		result["windowDurationMins"] = windowDurationMins
	}
	if hasResetsAt {
		result["resetsAt"] = resetsAt
	}
	return result
}

func decodeParams(raw json.RawMessage, target any) error {
	return json.Unmarshal(raw, target)
}

func asString(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	return ""
}

func asFloat(value any) float64 {
	if typed, ok := value.(float64); ok {
		return typed
	}
	return 0
}

func asMap(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return map[string]any{}
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstStringValue(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := asString(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func firstNumberValue(values map[string]any, keys ...string) (float64, bool) {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			if parsed, ok := numberValue(value); ok {
				return parsed, true
			}
		}
	}
	return 0, false
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func tokenValue(values map[string]any, keys ...string) float64 {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			return asFloat(value)
		}
	}
	return 0
}
