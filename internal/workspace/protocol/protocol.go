package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

const ProtocolVersion = 1

const (
	EnvelopeSubscribe   = "subscribe"
	EnvelopeUnsubscribe = "unsubscribe"
	EnvelopeCommand     = "command"
	EnvelopeSnapshot    = "snapshot"
	EnvelopeEvent       = "event"
	EnvelopeAck         = "ack"
	EnvelopeError       = "error"
)

const (
	TopicSidebar       = "sidebar"
	TopicLocalProjects = "local-projects"
	TopicUpdate        = "update"
	TopicKeybindings   = "keybindings"
	TopicAppSettings   = "app-settings"
	TopicChat          = "chat"
	TopicProjectGit    = "project-git"
	TopicTerminal      = "terminal"
	// TopicGlobalEvents carries application-wide notifications over the
	// existing workspace websocket. Keeping it on the same socket prevents a
	// second, long-lived HTTP connection per browser tab.
	TopicGlobalEvents = "global-events"
)

const (
	SnapshotSidebar       = "sidebar"
	SnapshotLocalProjects = "local-projects"
	SnapshotUpdate        = "update"
	SnapshotKeybindings   = "keybindings"
	SnapshotAppSettings   = "app-settings"
	SnapshotLLMProvider   = "llm-provider"
	SnapshotChat          = "chat"
	SnapshotProjectGit    = "project-git"
	SnapshotTerminal      = "terminal"
	SnapshotGlobalEvents  = "global-events"
)

const (
	CommandProjectOpen                     = "project.open"
	CommandProjectCreate                   = "project.create"
	CommandProjectRename                   = "project.rename"
	CommandProjectRemove                   = "project.remove"
	CommandSidebarReorderProjectGroups     = "sidebar.reorderProjectGroups"
	CommandProjectReadDiffPatch            = "project.readDiffPatch"
	CommandSystemPing                      = "system.ping"
	CommandBrowserListLocalHTTPServers     = "browser.listLocalHttpServers"
	CommandBrowserKillLocalHTTPServer      = "browser.killLocalHttpServer"
	CommandProjectReadQuickActions         = "project.readQuickActions"
	CommandProjectWriteQuickActions        = "project.writeQuickActions"
	CommandProjectReadRunnableScripts      = "project.readRunnableScripts"
	CommandUpdateCheck                     = "update.check"
	CommandUpdateInstall                   = "update.install"
	CommandAppReadManagement               = "app.readManagement"
	CommandAppWriteManagementSettings      = "app.writeManagementSettings"
	CommandAppReloadSessions               = "app.reloadSessions"
	CommandAppRestart                      = "app.restart"
	CommandAppReadHooksStatus              = "app.readHooksStatus"
	CommandSettingsReadKeybindings         = "settings.readKeybindings"
	CommandSettingsWriteKeybindings        = "settings.writeKeybindings"
	CommandSettingsReadAppSettings         = "settings.readAppSettings"
	CommandSettingsWriteAppSettingsPatch   = "settings.writeAppSettingsPatch"
	CommandSettingsRefreshProviderModels   = "settings.refreshProviderModels"
	CommandSettingsReadLLMProvider         = "settings.readLlmProvider"
	CommandSettingsWriteLLMProvider        = "settings.writeLlmProvider"
	CommandSettingsValidateLLMProvider     = "settings.validateLlmProvider"
	CommandSkillsSearch                    = "skills.search"
	CommandSkillsInstall                   = "skills.install"
	CommandSkillsUninstall                 = "skills.uninstall"
	CommandSkillsListInstalled             = "skills.listInstalled"
	CommandSkillsListOperations            = "skills.listOperations"
	CommandMCPList                         = "mcp.list"
	CommandMCPSave                         = "mcp.save"
	CommandMCPRemove                       = "mcp.remove"
	CommandMCPRegistrySearch               = "mcp.registrySearch"
	CommandMCPRegistryInstall              = "mcp.registryInstall"
	CommandSystemOpenExternal              = "system.openExternal"
	CommandChatCreate                      = "chat.create"
	CommandChatFork                        = "chat.fork"
	CommandChatConvertPreview              = "chat.convertPreview"
	CommandChatConvert                     = "chat.convert"
	CommandChatExportTranscript            = "chat.exportTranscript"
	CommandChatMigrateToTmux               = "chat.migrateToTmux"
	CommandChatRename                      = "chat.rename"
	CommandChatArchive                     = "chat.archive"
	CommandChatUnarchive                   = "chat.unarchive"
	CommandChatPin                         = "chat.pin"
	CommandChatReorderPinned               = "chat.reorderPinned"
	CommandChatDelete                      = "chat.delete"
	CommandChatSetDraftProtection          = "chat.setDraftProtection"
	CommandChatMarkRead                    = "chat.markRead"
	CommandChatRefresh                     = "chat.refresh"
	CommandChatClaimCodexSession           = "chat.claimCodexSession"
	CommandChatReleaseCodexSession         = "chat.releaseCodexSession"
	CommandChatTakeOverCodexSession        = "chat.takeOverCodexSession"
	CommandChatSetCodexExecutionMode       = "chat.setCodexExecutionMode"
	CommandChatSetPlanMode                 = "chat.setPlanMode"
	CommandChatReloadCodexAuth             = "chat.reloadCodexAuth"
	CommandChatSend                        = "chat.send"
	CommandChatRefreshDiffs                = "chat.refreshDiffs"
	CommandChatInitGit                     = "chat.initGit"
	CommandChatGetGitHubPublishInfo        = "chat.getGitHubPublishInfo"
	CommandChatCheckGitHubRepoAvailability = "chat.checkGitHubRepoAvailability"
	CommandChatPublishToGitHub             = "chat.publishToGitHub"
	CommandChatListBranches                = "chat.listBranches"
	CommandChatPreviewMergeBranch          = "chat.previewMergeBranch"
	CommandChatMergeBranch                 = "chat.mergeBranch"
	CommandChatSyncBranch                  = "chat.syncBranch"
	CommandChatCheckoutBranch              = "chat.checkoutBranch"
	CommandChatCreateBranch                = "chat.createBranch"
	CommandChatGenerateCommitMessage       = "chat.generateCommitMessage"
	CommandChatCommitDiffs                 = "chat.commitDiffs"
	CommandChatDiscardDiffFile             = "chat.discardDiffFile"
	CommandChatIgnoreDiffFile              = "chat.ignoreDiffFile"
	CommandChatListCheckpoints             = "chat.listCheckpoints"
	CommandChatRestoreCheckpoint           = "chat.restoreCheckpoint"
	CommandChatCancel                      = "chat.cancel"
	CommandChatStopDraining                = "chat.stopDraining"
	CommandChatReadTranscriptIndex         = "chat.readTranscriptIndex"
	CommandChatLoadHistory                 = "chat.loadHistory"
	CommandChatLoadHistoryAround           = "chat.loadHistoryAround"
	CommandChatRespondTool                 = "chat.respondTool"
	CommandMessageEnqueue                  = "message.enqueue"
	CommandMessageEdit                     = "message.edit"
	CommandMessageSteer                    = "message.steer"
	CommandMessageInterrupt                = "message.interrupt"
	CommandMessageDequeue                  = "message.dequeue"
	CommandTerminalCreate                  = "terminal.create"
	CommandTerminalInput                   = "terminal.input"
	CommandTerminalResize                  = "terminal.resize"
	CommandTerminalClose                   = "terminal.close"
)

type SubscriptionTopic struct {
	Type        string `json:"type"`
	ChatID      string `json:"chatId,omitempty"`
	RecentLimit *int   `json:"recentLimit,omitempty"`
	ProjectID   string `json:"projectId,omitempty"`
	TerminalID  string `json:"terminalId,omitempty"`
}

type ClientEnvelope struct {
	V       int                `json:"v"`
	Type    string             `json:"type"`
	ID      string             `json:"id,omitempty"`
	Topic   *SubscriptionTopic `json:"topic,omitempty"`
	Command json.RawMessage    `json:"command,omitempty"`
}

type ServerSnapshot struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type TerminalEvent struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
	Data       string `json:"data,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Signal     string `json:"signal,omitempty"`
}

type ServerEnvelope struct {
	V        int             `json:"v"`
	Type     string          `json:"type"`
	ID       string          `json:"id,omitempty"`
	Snapshot *ServerSnapshot `json:"snapshot,omitempty"`
	Event    any             `json:"event,omitempty"`
	Result   any             `json:"result,omitempty"`
	Message  string          `json:"message,omitempty"`
}

type commandHeader struct {
	Type string `json:"type"`
}

func DecodeClientEnvelope(data []byte) (ClientEnvelope, error) {
	var envelope ClientEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return ClientEnvelope{}, err
	}
	if err := envelope.Validate(); err != nil {
		return ClientEnvelope{}, err
	}
	return envelope, nil
}

func (e ClientEnvelope) Validate() error {
	if e.V != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version: %d", e.V)
	}
	switch e.Type {
	case EnvelopeSubscribe:
		if e.ID == "" {
			return errors.New("subscribe envelope requires id")
		}
		if e.Topic == nil || e.Topic.Type == "" {
			return errors.New("subscribe envelope requires topic")
		}
	case EnvelopeUnsubscribe:
		if e.ID == "" {
			return errors.New("unsubscribe envelope requires id")
		}
	case EnvelopeCommand:
		if e.ID == "" {
			return errors.New("command envelope requires id")
		}
		if len(e.Command) == 0 {
			return errors.New("command envelope requires command")
		}
		if _, err := CommandType(e.Command); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported envelope type: %s", e.Type)
	}
	return nil
}

func CommandType(command json.RawMessage) (string, error) {
	var header commandHeader
	if err := json.Unmarshal(command, &header); err != nil {
		return "", err
	}
	if header.Type == "" {
		return "", errors.New("command requires type")
	}
	return header.Type, nil
}

func SnapshotEnvelope(id string, snapshotType string, data any) ServerEnvelope {
	return ServerEnvelope{
		V:    ProtocolVersion,
		Type: EnvelopeSnapshot,
		ID:   id,
		Snapshot: &ServerSnapshot{
			Type: snapshotType,
			Data: data,
		},
	}
}

func EventEnvelope(id string, event any) ServerEnvelope {
	return ServerEnvelope{
		V:     ProtocolVersion,
		Type:  EnvelopeEvent,
		ID:    id,
		Event: event,
	}
}

func AckEnvelope(id string, result any) ServerEnvelope {
	return ServerEnvelope{
		V:      ProtocolVersion,
		Type:   EnvelopeAck,
		ID:     id,
		Result: result,
	}
}

func ErrorEnvelope(id string, message string) ServerEnvelope {
	return ServerEnvelope{
		V:       ProtocolVersion,
		Type:    EnvelopeError,
		ID:      id,
		Message: message,
	}
}
