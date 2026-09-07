package server

import (
	"abolqasem/internal/appinfo"
	"abolqasem/internal/boundedlog"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	claudeprovider "abolqasem/internal/providers/claude"
	codexprovider "abolqasem/internal/providers/codex"
	codexprotocol "abolqasem/internal/providers/codex/protocol"
	codexrpc "abolqasem/internal/providers/codex/rpc"
	opencodeprovider "abolqasem/internal/providers/opencode"
	"abolqasem/internal/providers/providerexec"
	"abolqasem/internal/state"
	"abolqasem/internal/workspace/agent"
	"abolqasem/internal/workspace/eventstore"
	"abolqasem/internal/workspace/readmodels"
	"abolqasem/internal/workspace/transcript"
)

type workspaceTurnStarter struct {
	store *eventstore.Store
}

var workspaceCodexSessions = newWorkspaceCodexSessionManager()
var workspaceLoadProviderSettings = state.LoadSettings

const workspaceCodexStartupRPCTimeout = 45 * time.Second

// workspaceCodexCredentialSwitch prevents a new turn from taking ownership of
// an app-server while a user is atomically replacing ~/.codex/auth.json. A
// read lock is held until the turn owns session.turnMu; a writer therefore
// either sees an idle process or cleanly asks the user to wait for the turn.
var workspaceCodexCredentialSwitch sync.RWMutex

type workspaceCodexSessionManager struct {
	mu       sync.Mutex
	sessions map[string]*workspaceCodexSession
}

type workspaceCodexSession struct {
	chatID              string
	cwd                 string
	threadID            string
	executionMode       string
	providerFingerprint string
	process             *workspaceCodexProcess
	turnMu              sync.Mutex
	idleDrainCancel     context.CancelFunc
	idleDrainDone       chan struct{}
}

type workspaceAsyncTurn struct {
	cancelMu      sync.Mutex
	cancel        func() error
	steer         func(context.Context, string, []readmodels.ChatAttachment) error
	events        chan agent.TurnEvent
	toolMu        sync.Mutex
	toolResponses map[string]chan workspaceToolResponse
}

type workspaceToolResponse struct {
	result any
	err    error
}

func newWorkspaceTurnStarter(store *eventstore.Store) *workspaceTurnStarter {
	return &workspaceTurnStarter{store: store}
}

func newWorkspaceCodexSessionManager() *workspaceCodexSessionManager {
	return &workspaceCodexSessionManager{
		sessions: map[string]*workspaceCodexSession{},
	}
}

func (m *workspaceCodexSessionManager) session(ctx context.Context, request agent.TurnRequest) (*workspaceCodexSession, error) {
	workspaceCodexCredentialSwitch.RLock()
	defer workspaceCodexCredentialSwitch.RUnlock()
	preparedRequest, runtime, err := workspacePrepareCodexTurn(request)
	if err != nil {
		return nil, err
	}
	request = preparedRequest
	m.mu.Lock()
	existingKey, existing := m.matchingSessionLocked(request.ChatID, request.SessionToken)
	if existing != nil && existing.reusableFor(request) {
		m.mu.Unlock()
		return existing, nil
	}
	if existing != nil {
		delete(m.sessions, existingKey)
	}
	m.mu.Unlock()

	if existing != nil {
		existing.close()
	}

	process, err := startWorkspaceCodexProcess(ctx, request.LocalPath, request.Env)
	if err != nil {
		return nil, err
	}
	if err := process.Initialize(ctx); err != nil {
		process.Close()
		return nil, process.wrapErr(err)
	}
	threadID, err := process.OpenThread(ctx, request)
	if err != nil {
		process.Close()
		return nil, process.wrapErr(err)
	}
	session := &workspaceCodexSession{
		chatID:              request.ChatID,
		cwd:                 request.LocalPath,
		threadID:            threadID,
		executionMode:       workspaceCodexExecutionPolicyFor(request.ExecutionMode).mode,
		providerFingerprint: runtime.Fingerprint,
		process:             process,
	}

	m.mu.Lock()
	_, replaced := m.matchingSessionLocked(request.ChatID, threadID)
	if replaced != nil && replaced != session {
		m.mu.Unlock()
		session.close()
		if replaced.reusableFor(request) {
			return replaced, nil
		}
		return nil, errors.New("codex session was replaced")
	}
	m.sessions[request.ChatID] = session
	m.mu.Unlock()
	return session, nil
}

// resetForCredentialSwitch closes every idle app-server process. It is called
// under workspaceCodexCredentialSwitch's write lock, so a new turn cannot race
// the inspection. A running turn is deliberately skipped: it keeps the token
// it already loaded and finishes normally, while later turns read auth.json.
func (m *workspaceCodexSessionManager) resetForCredentialSwitch() int {
	locked := m.lockIdleSessionsForCredentialSwitch()
	defer func() {
		for _, session := range locked {
			session.turnMu.Unlock()
		}
	}()
	for _, session := range locked {
		session.close()
	}
	m.mu.Lock()
	for key, session := range m.sessions {
		for _, closed := range locked {
			if session == closed {
				delete(m.sessions, key)
				break
			}
		}
	}
	m.mu.Unlock()
	return len(locked)
}

func (m *workspaceCodexSessionManager) lockIdleSessionsForCredentialSwitch() []*workspaceCodexSession {
	m.mu.Lock()
	sessions := make([]*workspaceCodexSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		if session != nil {
			sessions = append(sessions, session)
		}
	}
	m.mu.Unlock()

	locked := make([]*workspaceCodexSession, 0, len(sessions))
	for _, session := range sessions {
		if !session.turnMu.TryLock() {
			continue
		}
		locked = append(locked, session)
	}
	return locked
}

// resetIdleThread closes only this chat's app-server after its active turn has
// completed. The next message creates a fresh process and reads the currently
// selected auth.json without disturbing any other chat.
func (m *workspaceCodexSessionManager) resetIdleThread(chatID, threadID string) bool {
	m.mu.Lock()
	key, session := m.matchingSessionLocked(chatID, threadID)
	if session == nil || !session.turnMu.TryLock() {
		m.mu.Unlock()
		return false
	}
	delete(m.sessions, key)
	m.mu.Unlock()
	defer session.turnMu.Unlock()
	session.close()
	return true
}

func (m *workspaceCodexSessionManager) remove(chatID string, process *workspaceCodexProcess) {
	m.mu.Lock()
	if session := m.sessions[chatID]; session != nil && session.process == process {
		delete(m.sessions, chatID)
		m.mu.Unlock()
		return
	}
	for key, session := range m.sessions {
		if session != nil && session.process == process {
			delete(m.sessions, key)
			break
		}
	}
	m.mu.Unlock()
}

func (m *workspaceCodexSessionManager) close(chatID string) {
	m.closeThread(chatID, "")
}

func (m *workspaceCodexSessionManager) closeThread(chatID string, threadID string) {
	m.mu.Lock()
	key, session := m.matchingSessionLocked(chatID, threadID)
	if session != nil {
		delete(m.sessions, key)
	}
	m.mu.Unlock()
	if session != nil {
		session.close()
	}
}

func (m *workspaceCodexSessionManager) matchingSessionLocked(chatID string, threadID string) (string, *workspaceCodexSession) {
	threadID = strings.TrimSpace(threadID)
	if session := m.sessions[chatID]; session != nil && (threadID == "" || session.threadID == threadID) {
		return chatID, session
	}
	if threadID == "" {
		return "", nil
	}
	for key, session := range m.sessions {
		if session != nil && session.threadID == threadID {
			return key, session
		}
	}
	return "", nil
}

func (m *workspaceCodexSessionManager) ownerChatID(chatID string, threadID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	key, session := m.matchingSessionLocked(chatID, threadID)
	if session == nil {
		return ""
	}
	return key
}

func (m *workspaceCodexSessionManager) owns(chatID string, threadID string) bool {
	_, owned := m.ownedExecutionMode(chatID, threadID)
	return owned
}

func (m *workspaceCodexSessionManager) ownedExecutionMode(chatID string, threadID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, session := m.matchingSessionLocked(chatID, threadID)
	if session == nil || session.process == nil || session.process.Exited() || session.threadID != threadID {
		return "", false
	}
	return session.executionMode, true
}

func (m *workspaceCodexSessionManager) anyLiveProcess() *workspaceCodexProcess {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, session := range m.sessions {
		if session != nil && session.process != nil && !session.process.Exited() {
			return session.process
		}
	}
	return nil
}

// ownedExecutionModeByWriterPID is a recovery path for a live app-server whose
// persisted chat alias has not caught up yet. The writer PID comes from lsof,
// and the thread id prevents a different chat hosted by this server from being
// mistaken for the requested session.
func (m *workspaceCodexSessionManager) ownedExecutionModeByWriterPID(chatID string, threadID string, pid int) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, session := m.matchingSessionLocked(chatID, threadID)
	if session == nil || session.process == nil || session.process.Exited() || session.process.cmd == nil || session.process.cmd.Process == nil || session.process.cmd.Process.Pid != pid {
		return "", false
	}
	return session.executionMode, true
}

func (s *workspaceCodexSession) reusableFor(request agent.TurnRequest) bool {
	if s == nil || s.process == nil || s.process.Exited() {
		return false
	}
	if request.PendingForkSessionToken != "" {
		return false
	}
	if request.SessionToken != "" && s.threadID != request.SessionToken {
		return false
	}
	return s.cwd == request.LocalPath &&
		s.threadID != "" &&
		s.executionMode == workspaceCodexExecutionPolicyFor(request.ExecutionMode).mode &&
		s.providerFingerprint == workspaceCodexProviderFingerprint(request.CodexModelProvider)
}

type workspaceCodexExecutionPolicy struct {
	mode           string
	approvalPolicy string
	sandbox        string
}

func workspaceCodexExecutionPolicyFor(mode string) workspaceCodexExecutionPolicy {
	if mode == "standard" {
		return workspaceCodexExecutionPolicy{mode: "standard", approvalPolicy: "on-request", sandbox: "read-only"}
	}
	return workspaceCodexExecutionPolicy{mode: "dangerous", approvalPolicy: "never", sandbox: "danger-full-access"}
}

func (s *workspaceCodexSession) close() {
	if s == nil {
		return
	}
	s.stopIdleDrain()
	if s.process != nil {
		s.process.Close()
	}
}

func (s *workspaceCodexSession) startIdleDrain() {
	if s == nil || s.process == nil || s.process.Exited() {
		return
	}
	s.stopIdleDrain()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.idleDrainCancel = cancel
	s.idleDrainDone = done
	go func() {
		defer close(done)
		s.process.DrainIdleNotifications(ctx)
	}()
}

func (s *workspaceCodexSession) stopIdleDrain() {
	if s == nil || s.idleDrainCancel == nil {
		return
	}
	cancel := s.idleDrainCancel
	done := s.idleDrainDone
	s.idleDrainCancel = nil
	s.idleDrainDone = nil
	cancel()
	if done != nil {
		<-done
	}
}

func (s *workspaceTurnStarter) StartTurn(ctx context.Context, request agent.TurnRequest) (agent.Turn, error) {
	project, chat, err := s.turnContext(request.ChatID, request.ProjectID)
	if err != nil {
		return nil, err
	}
	request.ProjectID = project.ID
	request.LocalPath = project.LocalPath
	if request.SessionToken == "" {
		request.SessionToken = derefWorkspaceString(chat.SessionToken)
	}
	if request.PendingForkSessionToken == "" {
		request.PendingForkSessionToken = derefWorkspaceString(chat.PendingForkSessionToken)
	}

	switch request.Provider {
	case "codex":
		return startWorkspaceCodexTurn(ctx, request), nil
	case "claude":
		return startWorkspaceClaudeTurn(ctx, request), nil
	case "opencode":
		return startWorkspaceOpenCodeTurn(ctx, request), nil
	default:
		return nil, fmt.Errorf("unsupported provider: %s", request.Provider)
	}
}

func (s *workspaceTurnStarter) turnContext(chatID string, projectID string) (readmodels.ProjectRecord, readmodels.ChatRecord, error) {
	storeState, err := s.store.LoadState()
	if err != nil {
		return readmodels.ProjectRecord{}, readmodels.ChatRecord{}, err
	}
	chat, ok := storeState.ChatsByID[chatID]
	if !ok || chat.DeletedAt != 0 {
		return readmodels.ProjectRecord{}, readmodels.ChatRecord{}, errors.New("chat not found")
	}
	if projectID == "" {
		projectID = chat.ProjectID
	}
	project, ok := storeState.ProjectsByID[projectID]
	if !ok || project.DeletedAt != 0 {
		return readmodels.ProjectRecord{}, readmodels.ChatRecord{}, errors.New("project not found")
	}
	if strings.TrimSpace(project.LocalPath) == "" {
		return readmodels.ProjectRecord{}, readmodels.ChatRecord{}, errors.New("project local path is empty")
	}
	return project, chat, nil
}

func (t *workspaceAsyncTurn) Cancel() error {
	if t == nil {
		return nil
	}
	t.cancelMu.Lock()
	cancel := t.cancel
	t.cancelMu.Unlock()
	if cancel == nil {
		return nil
	}
	return cancel()
}

func (t *workspaceAsyncTurn) Events() <-chan agent.TurnEvent {
	if t == nil {
		return nil
	}
	return t.events
}

func (t *workspaceAsyncTurn) setCancel(cancel func() error) {
	t.cancelMu.Lock()
	defer t.cancelMu.Unlock()
	t.cancel = cancel
}

func (t *workspaceAsyncTurn) Steer(ctx context.Context, content string, attachments []readmodels.ChatAttachment) error {
	t.cancelMu.Lock()
	steer := t.steer
	t.cancelMu.Unlock()
	if steer == nil {
		return agent.ErrSteerUnsupported
	}
	return steer(ctx, content, attachments)
}

func (t *workspaceAsyncTurn) setSteer(steer func(context.Context, string, []readmodels.ChatAttachment) error) {
	t.cancelMu.Lock()
	defer t.cancelMu.Unlock()
	t.steer = steer
}

func (t *workspaceAsyncTurn) RespondTool(_ context.Context, response agent.ToolResponse) error {
	if t == nil {
		return agent.ErrToolResponseUnsupported
	}
	t.toolMu.Lock()
	responseCh := t.toolResponses[response.ToolUseID]
	if responseCh != nil {
		delete(t.toolResponses, response.ToolUseID)
	}
	t.toolMu.Unlock()
	if responseCh == nil {
		return agent.ErrPendingToolNotFound
	}
	responseCh <- workspaceToolResponse{result: response.Result}
	return nil
}

func startWorkspaceClaudeTurn(parent context.Context, request agent.TurnRequest) agent.Turn {
	ctx, cancel := context.WithCancel(parent)
	turn := &workspaceAsyncTurn{
		cancel: func() error {
			cancel()
			return nil
		},
		events:        make(chan agent.TurnEvent, 32),
		toolResponses: map[string]chan workspaceToolResponse{},
	}
	go func() {
		defer close(turn.events)
		adapter := claudeprovider.NewAdapter("")
		sessionToken := request.SessionToken
		forkSession := false
		if request.PendingForkSessionToken != "" {
			sessionToken = request.PendingForkSessionToken
			forkSession = true
		}
		result, err := adapter.RunPromptResult(ctx, claudeprovider.PromptRequest{
			CWD:          request.LocalPath,
			Model:        request.Model,
			Effort:       request.Effort,
			PlanMode:     request.PlanMode,
			SessionToken: sessionToken,
			ForkSession:  forkSession,
			Prompt:       workspacePromptText(request.Content, request.Attachments),
			Env:          request.Env,
		})
		if err != nil {
			if ctx.Err() != nil {
				turn.events <- agent.TurnEvent{Type: agent.TurnEventCancelled}
				return
			}
			turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: err}
			return
		}
		if result.SessionToken != "" {
			turn.events <- agent.TurnEvent{Type: agent.TurnEventSessionToken, SessionToken: result.SessionToken}
		}
		for _, entry := range result.Entries {
			turn.events <- agent.TurnEvent{Type: agent.TurnEventTranscript, Entry: entry}
		}
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFinished}
	}()
	return turn
}

func startWorkspaceOpenCodeTurn(parent context.Context, request agent.TurnRequest) agent.Turn {
	ctx, cancel := context.WithCancel(parent)
	turn := &workspaceAsyncTurn{
		cancel: func() error {
			cancel()
			return nil
		},
		events:        make(chan agent.TurnEvent, 32),
		toolResponses: map[string]chan workspaceToolResponse{},
	}
	go func() {
		defer close(turn.events)
		if settings, err := workspaceLoadProviderSettings(); err == nil {
			providerexec.SetConfiguredExecutables(settings.ProviderExecutables)
		}
		sessionToken := request.SessionToken
		forkSession := false
		if request.PendingForkSessionToken != "" {
			sessionToken = request.PendingForkSessionToken
			forkSession = true
		}
		prompt := workspacePromptText(request.Content, request.Attachments)
		if sessionToken == "" {
			prompt = workspaceOpenCodePromptWithContext(request.ChatID, prompt)
		}
		result, err := opencodeprovider.NewAdapter(providerexec.ExecutableOrName("opencode")).RunPromptResult(ctx, opencodeprovider.PromptRequest{
			CWD:          request.LocalPath,
			Model:        request.Model,
			Effort:       request.Effort,
			SessionToken: sessionToken,
			ForkSession:  forkSession,
			Prompt:       prompt,
			Env:          request.Env,
		})
		if err != nil {
			if ctx.Err() != nil {
				turn.events <- agent.TurnEvent{Type: agent.TurnEventCancelled}
				return
			}
			turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: err}
			return
		}
		if result.SessionToken != "" {
			turn.events <- agent.TurnEvent{Type: agent.TurnEventSessionToken, SessionToken: result.SessionToken}
		}
		for _, entry := range result.Entries {
			turn.events <- agent.TurnEvent{Type: agent.TurnEventTranscript, Entry: entry}
		}
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFinished}
	}()
	return turn
}

func workspaceOpenCodePromptWithContext(chatID string, prompt string) string {
	source, err := workspaceConversionSource(chatID)
	if err != nil || len(source.Entries) == 0 {
		return prompt
	}
	entries := source.Entries
	if len(entries) > 0 && transcript.Kind(entries[len(entries)-1]) == transcript.KindUserPrompt && strings.TrimSpace(stringValue(entries[len(entries)-1]["content"])) == strings.TrimSpace(prompt) {
		entries = entries[:len(entries)-1]
	}
	var history strings.Builder
	for _, entry := range entries {
		switch transcript.Kind(entry) {
		case transcript.KindUserPrompt:
			if text := strings.TrimSpace(stringValue(entry["content"])); text != "" {
				history.WriteString("User: ")
				history.WriteString(text)
				history.WriteString("\n\n")
			}
		case transcript.KindAssistantText:
			if text := strings.TrimSpace(stringValue(entry["text"])); text != "" {
				history.WriteString("Assistant: ")
				history.WriteString(text)
				history.WriteString("\n\n")
			}
		}
	}
	if history.Len() == 0 {
		return prompt
	}
	return "Continue this conversation. The transcript below is context; answer the final user message.\n\n" + history.String() + "User: " + prompt
}

func startWorkspaceCodexTurn(parent context.Context, request agent.TurnRequest) agent.Turn {
	ctx, cancel := context.WithCancel(parent)
	turn := &workspaceAsyncTurn{
		cancel: func() error {
			cancel()
			return nil
		},
		events:        make(chan agent.TurnEvent, 128),
		toolResponses: map[string]chan workspaceToolResponse{},
	}
	go runWorkspaceCodexTurn(ctx, cancel, request, turn)
	return turn
}

func runWorkspaceCodexTurn(ctx context.Context, turnCancel context.CancelFunc, request agent.TurnRequest, turn *workspaceAsyncTurn) {
	defer close(turn.events)
	preparedRequest, _, err := workspacePrepareCodexTurn(request)
	if err != nil {
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: err}
		return
	}
	request = preparedRequest

	// Keep the credential-switch read lock through acquisition of turnMu. This
	// makes an account switch all-or-nothing relative to a new turn.
	workspaceCodexCredentialSwitch.RLock()
	sessionCtx, cancelSession := context.WithTimeout(ctx, workspaceCodexStartupRPCTimeout)
	session, err := workspaceCodexSessions.session(sessionCtx, request)
	cancelSession()
	if err != nil {
		workspaceCodexCredentialSwitch.RUnlock()
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: err}
		return
	}
	session.turnMu.Lock()
	workspaceCodexCredentialSwitch.RUnlock()
	defer session.turnMu.Unlock()
	session.stopIdleDrain()
	process := session.process
	threadID := session.threadID
	if threadID != "" {
		turn.events <- agent.TurnEvent{Type: agent.TurnEventSessionToken, SessionToken: threadID}
	}

	startCtx, cancelStart := context.WithTimeout(ctx, workspaceCodexStartupRPCTimeout)
	turnID, err := process.StartTurn(startCtx, threadID, request)
	cancelStart()
	if err != nil {
		workspaceCodexSessions.remove(request.ChatID, process)
		process.Close()
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: process.wrapErr(err)}
		return
	}
	turn.events <- agent.TurnEvent{Type: agent.TurnEventStarted, SessionToken: threadID, TurnID: turnID}
	turn.setCancel(func() error {
		cancelCtx, timeoutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer timeoutCancel()
		err := process.InterruptTurn(cancelCtx, threadID, turnID)
		turnCancel()
		if err != nil {
			workspaceCodexSessions.remove(request.ChatID, process)
			process.Close()
			return err
		}
		return nil
	})
	turn.setSteer(func(steerCtx context.Context, content string, attachments []readmodels.ChatAttachment) error {
		return process.SteerTurn(steerCtx, threadID, turnID, content, attachments)
	})

	process.ForwardEvents(ctx, turn, threadID, turnID)
	if process.Exited() {
		workspaceCodexSessions.remove(request.ChatID, process)
		return
	}
	session.startIdleDrain()
}

type workspaceCodexProcess struct {
	cmd       *exec.Cmd
	client    *codexrpc.Client
	transport *workspaceCodexTransport
	logFile   *boundedlog.File
	logPath   string
	done      chan struct{}
	doneMu    sync.Mutex
	doneErr   error
}

type workspaceCodexTransport struct {
	stdin   io.WriteCloser
	logFile *boundedlog.File
	mu      sync.Mutex
}

func startWorkspaceCodexProcess(ctx context.Context, cwd string, env []string) (*workspaceCodexProcess, error) {
	// Abolqasem keeps codex app-server alive across turns; turn cancellation is sent via turn/interrupt.
	_ = ctx
	if settings, err := workspaceLoadProviderSettings(); err == nil {
		providerexec.SetConfiguredExecutables(settings.ProviderExecutables)
	}
	cmd := exec.Command(providerexec.ExecutableOrName("codex"), "app-server")
	cmd.Env = state.CurrentProviderProxyEnvWithOverrides(env)
	if cwd != "" {
		cmd.Dir = cwd
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	logFile, logPath := createWorkspaceCodexLogFile()
	transport := &workspaceCodexTransport{stdin: stdin, logFile: logFile}
	client := codexrpc.NewClient(transport)
	process := &workspaceCodexProcess{
		cmd:       cmd,
		client:    client,
		transport: transport,
		logFile:   logFile,
		logPath:   logPath,
		done:      make(chan struct{}),
	}
	if err := cmd.Start(); err != nil {
		if logFile != nil {
			_ = logFile.Close()
		}
		return nil, err
	}
	process.logf("started codex app-server pid=%d cwd=%s", cmd.Process.Pid, cwd)
	go process.scanStdout(stdout)
	go process.scanStderr(stderr)
	go func() {
		err := cmd.Wait()
		process.doneMu.Lock()
		process.doneErr = err
		process.doneMu.Unlock()
		process.client.Close(err)
		close(process.done)
	}()
	return process, nil
}

func (p *workspaceCodexProcess) Initialize(ctx context.Context) error {
	var result any
	if err := p.client.Call(ctx, "initialize", codexprotocol.InitializeParams{
		ClientInfo: codexprotocol.ClientInfo{
			Name:    appinfo.Name,
			Title:   appinfo.DisplayName,
			Version: "dev",
		},
		Capabilities: codexprotocol.Capabilities{
			ExperimentalAPI: true,
		},
	}, &result); err != nil {
		return err
	}
	return p.notify("initialized", nil)
}

func (p *workspaceCodexProcess) OpenThread(ctx context.Context, request agent.TurnRequest) (string, error) {
	executionPolicy := workspaceCodexExecutionPolicyFor(request.ExecutionMode)
	approvalPolicy := executionPolicy.approvalPolicy
	sandbox := executionPolicy.sandbox
	persistExtendedHistory := false
	model := optionalWorkspaceString(request.Model)
	modelProvider := optionalWorkspaceString(request.CodexModelProvider)
	cwd := optionalWorkspaceString(request.LocalPath)
	serviceTier := optionalWorkspaceString(request.ServiceTier)

	if request.PendingForkSessionToken != "" {
		var response codexprotocol.ThreadForkResponse
		err := p.client.Call(ctx, "thread/fork", codexprotocol.ThreadForkParams{
			ThreadID:               request.PendingForkSessionToken,
			ModelProvider:          modelProvider,
			Model:                  model,
			CWD:                    cwd,
			ServiceTier:            serviceTier,
			ApprovalPolicy:         &approvalPolicy,
			Sandbox:                &sandbox,
			PersistExtendedHistory: persistExtendedHistory,
		}, &response)
		if err != nil {
			return "", err
		}
		return response.Thread.ID, nil
	}

	if request.SessionToken != "" {
		var response codexprotocol.ThreadResumeResponse
		err := p.client.Call(ctx, "thread/resume", codexprotocol.ThreadResumeParams{
			ThreadID:               request.SessionToken,
			ModelProvider:          modelProvider,
			Model:                  model,
			CWD:                    cwd,
			ServiceTier:            serviceTier,
			ApprovalPolicy:         &approvalPolicy,
			Sandbox:                &sandbox,
			PersistExtendedHistory: persistExtendedHistory,
		}, &response)
		if err == nil {
			return response.Thread.ID, nil
		}
		if !isWorkspaceRecoverableCodexResumeError(err) {
			return "", err
		}
	}

	var response codexprotocol.ThreadStartResponse
	err := p.client.Call(ctx, "thread/start", codexprotocol.ThreadStartParams{
		ModelProvider:          modelProvider,
		Model:                  model,
		CWD:                    cwd,
		ServiceTier:            serviceTier,
		ApprovalPolicy:         &approvalPolicy,
		Sandbox:                &sandbox,
		ExperimentalRawEvents:  false,
		PersistExtendedHistory: persistExtendedHistory,
	}, &response)
	if err != nil {
		return "", err
	}
	return response.Thread.ID, nil
}

func (p *workspaceCodexProcess) StartTurn(ctx context.Context, threadID string, request agent.TurnRequest) (string, error) {
	model := optionalWorkspaceString(request.Model)
	effort := optionalWorkspaceString(request.Effort)
	serviceTier := optionalWorkspaceString(request.ServiceTier)
	approvalPolicy := workspaceCodexExecutionPolicyFor(request.ExecutionMode).approvalPolicy
	mode := "default"
	if request.PlanMode {
		mode = "plan"
	}

	params := codexprotocol.TurnStartParams{
		ThreadID:       threadID,
		Input:          workspaceCodexInputs(request.Content, request.Attachments),
		ApprovalPolicy: &approvalPolicy,
		Model:          model,
		Effort:         effort,
		ServiceTier:    serviceTier,
		CollaborationMode: &codexprotocol.CollaborationMode{
			Mode: mode,
			Settings: codexprotocol.CollaborationModeSettings{
				Model: model,
				// Newer app-server versions read the reasoning level from the
				// collaboration settings. Keep the top-level effort field above for
				// older servers, but do not leave this field nil or UI high/xhigh
				// selections silently fall back to the server default.
				ReasoningEffort:       effort,
				DeveloperInstructions: nil,
			},
		},
	}

	var response codexprotocol.TurnStartResponse
	if err := p.client.Call(ctx, "turn/start", params, &response); err != nil {
		return "", err
	}
	return response.Turn.ID, nil
}

func workspaceCodexInputs(content string, attachments []readmodels.ChatAttachment) []codexprotocol.UserInput {
	inputs := make([]codexprotocol.UserInput, 0, len(attachments)+1)
	if text := workspacePromptText(content, attachments); text != "" {
		inputs = append(inputs, codexprotocol.UserInput{Type: "text", Text: text, TextElements: []string{}})
	}
	for _, attachment := range attachments {
		path := strings.TrimSpace(attachment.AbsolutePath)
		if path == "" {
			continue
		}
		if attachment.Kind == "image" || strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
			inputs = append(inputs, codexprotocol.UserInput{Type: "localImage", Path: path})
		}
	}
	if len(inputs) == 0 {
		inputs = append(inputs, codexprotocol.UserInput{Type: "text", Text: "Please inspect the attached input.", TextElements: []string{}})
	}
	return inputs
}
func (p *workspaceCodexProcess) InterruptTurn(ctx context.Context, threadID string, turnID string) error {
	if p == nil || p.client == nil || threadID == "" || turnID == "" {
		return nil
	}
	var result any
	return p.client.Call(ctx, "turn/interrupt", codexprotocol.TurnInterruptParams{
		ThreadID: threadID,
		TurnID:   turnID,
	}, &result)
}

func (p *workspaceCodexProcess) SteerTurn(ctx context.Context, threadID string, turnID string, content string, attachments []readmodels.ChatAttachment) error {
	var result any
	return p.client.Call(ctx, "turn/steer", codexprotocol.TurnSteerParams{ThreadID: threadID, ExpectedTurnID: turnID, Input: workspaceCodexInputs(content, attachments)}, &result)
}

func (p *workspaceCodexProcess) Exited() bool {
	if p == nil || p.done == nil {
		return true
	}
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (p *workspaceCodexProcess) DoneErr() error {
	if p == nil {
		return nil
	}
	p.doneMu.Lock()
	defer p.doneMu.Unlock()
	return p.doneErr
}

func (p *workspaceCodexProcess) ForwardEvents(ctx context.Context, turn *workspaceAsyncTurn, threadID string, turnID string) {
	normalizer := codexprovider.NewStreamNormalizer()
	for {
		select {
		case <-ctx.Done():
			turn.events <- agent.TurnEvent{Type: agent.TurnEventCancelled}
			return
		case <-p.done:
			if ctx.Err() != nil {
				turn.events <- agent.TurnEvent{Type: agent.TurnEventCancelled}
				return
			}
			if err := p.DoneErr(); err != nil {
				turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: p.wrapErr(err)}
				return
			}
			turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: p.wrapErr(errors.New("codex app-server stopped before turn completed"))}
			return
		case notification := <-p.client.Notifications():
			if notification.ID != "" {
				p.handleServerRequest(ctx, turn, notification)
				continue
			}
			for _, item := range normalizer.HandleNotification(notification) {
				forwardWorkspaceHarnessEvent(item, turn.events)
			}
			if notification.Method == "turn/completed" {
				status, message, matched := workspaceCodexTurnCompletion(notification.Params, turnID)
				if !matched {
					continue
				}
				switch status {
				case "failed":
					turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Message: firstNonEmptyWorkspaceString(message, "codex turn failed")}
				case "interrupted", "cancelled", "canceled":
					turn.events <- agent.TurnEvent{Type: agent.TurnEventCancelled}
				default:
					turn.events <- agent.TurnEvent{Type: agent.TurnEventFinished}
				}
				return
			}
			if notification.Method == "error" {
				message := workspaceCodexErrorMessage(notification.Params)
				turn.events <- agent.TurnEvent{Type: agent.TurnEventTranscript, Entry: workspaceCodexResultEntry("error", true, message)}
				turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Message: message}
				return
			}
		}
	}
}

func (p *workspaceCodexProcess) DrainIdleNotifications(ctx context.Context) {
	if p == nil || p.client == nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.done:
			return
		case notification := <-p.client.Notifications():
			if notification.ID != "" {
				p.respondNoActiveTurn(notification.ID)
			}
		}
	}
}

func (p *workspaceCodexProcess) respondNoActiveTurn(id string) {
	if p == nil || p.transport == nil || strings.TrimSpace(id) == "" {
		return
	}
	data, err := json.Marshal(map[string]any{
		"id": id,
		"error": map[string]any{
			"message": "No active turn",
		},
	})
	if err != nil {
		return
	}
	_ = p.transport.Send(data)
}

func (p *workspaceCodexProcess) handleServerRequest(ctx context.Context, turn *workspaceAsyncTurn, notification codexrpc.Notification) {
	harnessEvents, response, err := codexprovider.HandleServerRequest(codexprovider.ServerRequest{
		ID:     notification.ID,
		Method: notification.Method,
		Params: notification.Params,
	}, codexprovider.RequestHandlers{
		OnToolRequest: func(request codexprovider.ToolRequest) (map[string]any, error) {
			return turn.waitForToolResponse(ctx, request)
		},
		OnApprovalRequest: func(request codexprovider.ApprovalRequest) (string, error) {
			result, err := turn.waitForToolResponse(ctx, codexprovider.ToolRequest{Tool: request.Tool})
			if err != nil {
				return "decline", err
			}
			decision, _ := result["decision"].(string)
			return decision, nil
		},
	})
	if err != nil {
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: err}
		return
	}
	if notification.Method != "item/tool/requestUserInput" {
		for _, item := range harnessEvents {
			forwardWorkspaceHarnessEvent(item, turn.events)
		}
	}
	data, err := json.Marshal(response)
	if err != nil {
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: err}
		return
	}
	if err := p.transport.Send(data); err != nil {
		turn.events <- agent.TurnEvent{Type: agent.TurnEventFailed, Error: err}
	}
}

func (t *workspaceAsyncTurn) waitForToolResponse(ctx context.Context, request codexprovider.ToolRequest) (map[string]any, error) {
	toolID := stringValue(request.Tool["toolId"])
	if toolID == "" {
		toolID = stringValue(request.Tool["id"])
	}
	if toolID == "" {
		return map[string]any{}, nil
	}
	responseCh := make(chan workspaceToolResponse, 1)
	t.toolMu.Lock()
	t.toolResponses[toolID] = responseCh
	t.toolMu.Unlock()
	defer func() {
		t.toolMu.Lock()
		delete(t.toolResponses, toolID)
		t.toolMu.Unlock()
	}()

	toolKind := stringValue(request.Tool["toolKind"])
	if toolKind == "" {
		toolKind = "ask_user_question"
	}
	t.events <- agent.TurnEvent{
		Type: agent.TurnEventPendingTool,
		PendingTool: &agent.PendingToolRequest{
			ToolUseID: toolID,
			ToolKind:  toolKind,
			ToolName:  stringValue(request.Tool["toolName"]),
			Input:     request.Tool["input"],
		},
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case response := <-responseCh:
		if response.err != nil {
			return nil, response.err
		}
		if result, ok := response.result.(map[string]any); ok {
			return result, nil
		}
		return map[string]any{"answers": response.result}, nil
	}
}

func (p *workspaceCodexProcess) Close() {
	if p == nil {
		return
	}
	if p.transport != nil && p.transport.stdin != nil {
		_ = p.transport.stdin.Close()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	if p.done != nil {
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
		}
	}
	p.logf("closed codex app-server")
	if p.logFile != nil {
		_ = p.logFile.Close()
	}
}

func (p *workspaceCodexProcess) notify(method string, params any) error {
	payload := map[string]any{"method": method}
	if params != nil {
		payload["params"] = params
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return p.transport.Send(data)
}

func (p *workspaceCodexProcess) scanStdout(stdout io.Reader) {
	err := readWorkspaceCodexLines(stdout, func(line []byte) {
		p.logf("<< %s", workspaceCodexLogJSON(line))
		if err := p.client.HandleMessage(line); err != nil {
			p.logf("invalid codex message: %s", err.Error())
		}
	})
	if err != nil {
		p.logf("stdout scan failed: %s", err.Error())
	}
}

func (p *workspaceCodexProcess) scanStderr(stderr io.Reader) {
	err := readWorkspaceCodexLines(stderr, func(raw []byte) {
		line := strings.TrimSpace(string(raw))
		if line != "" {
			p.client.RecordStderr(redactWorkspaceCodexText(line))
			p.logf("!! %s", redactWorkspaceCodexText(line))
		}
	})
	if err != nil {
		p.logf("stderr scan failed: %s", err.Error())
	}
}

func readWorkspaceCodexLines(source io.Reader, handle func([]byte)) error {
	reader := bufio.NewReaderSize(source, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		line = bytes.TrimSuffix(line, []byte{'\n'})
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if len(line) > 0 {
			handle(line)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func workspaceCodexLogJSON(message []byte) string {
	const detailedLogLimit = 256 * 1024
	if len(message) > detailedLogLimit {
		return fmt.Sprintf("[large JSON-RPC message: %d bytes]", len(message))
	}
	return redactWorkspaceCodexJSON(message)
}

func (p *workspaceCodexProcess) wrapErr(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if stderr := strings.TrimSpace(p.client.Stderr()); stderr != "" {
		message = message + ": " + stderr
	}
	if p.logPath != "" {
		return fmt.Errorf("%s (log: %s)", message, p.logPath)
	}
	return errors.New(message)
}

func (p *workspaceCodexProcess) logf(format string, args ...any) {
	if p == nil || p.logFile == nil {
		return
	}
	_, _ = fmt.Fprintf(p.logFile, "%s %s\n", time.Now().Format(time.RFC3339Nano), fmt.Sprintf(format, args...))
}

func (t *workspaceCodexTransport) Send(message []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.logFile != nil {
		_, _ = fmt.Fprintf(t.logFile, "%s >> %s\n", time.Now().Format(time.RFC3339Nano), redactWorkspaceCodexJSON(message))
	}
	payload := append(append([]byte(nil), message...), '\n')
	_, err := t.stdin.Write(payload)
	return err
}

func forwardWorkspaceHarnessEvent(event codexprovider.HarnessEvent, out chan<- agent.TurnEvent) {
	switch event.Type {
	case "session_token":
		if event.SessionToken != "" {
			out <- agent.TurnEvent{Type: agent.TurnEventSessionToken, SessionToken: event.SessionToken}
		}
	case "transcript":
		if event.Entry != nil {
			if transcript.Kind(event.Entry) == transcript.KindRateLimitUpdated {
				workspaceStoreCodexUsage(event.Entry["rateLimits"])
			}
			out <- agent.TurnEvent{Type: agent.TurnEventTranscript, Entry: event.Entry}
		}
	}
}

func workspaceCodexTurnCompletion(raw json.RawMessage, turnID string) (string, string, bool) {
	var params struct {
		Turn map[string]any `json:"turn"`
	}
	if json.Unmarshal(raw, &params) != nil || params.Turn == nil {
		return "", "", true
	}
	if turnID != "" && stringValue(params.Turn["id"]) != "" && stringValue(params.Turn["id"]) != turnID {
		return "", "", false
	}
	status := strings.ToLower(stringValue(params.Turn["status"]))
	errorMessage := ""
	if errMap, ok := params.Turn["error"].(map[string]any); ok {
		errorMessage = stringValue(errMap["message"])
	}
	return status, errorMessage, true
}

func workspaceCodexErrorMessage(raw json.RawMessage) string {
	var params map[string]any
	if json.Unmarshal(raw, &params) != nil {
		return "codex reported an error"
	}
	if errMap, ok := params["error"].(map[string]any); ok {
		if message := stringValue(errMap["message"]); message != "" {
			return message
		}
	}
	if message := stringValue(params["message"]); message != "" {
		return message
	}
	return "codex reported an error"
}

func workspaceCodexResultEntry(subtype string, isError bool, message string) readmodels.TranscriptEntry {
	return transcript.New(transcript.KindResult, map[string]any{
		"subtype":    subtype,
		"isError":    isError,
		"durationMs": float64(0),
		"result":     message,
	})
}

func workspacePromptText(content string, attachments []readmodels.ChatAttachment) string {
	content = strings.TrimSpace(content)
	if len(attachments) == 0 {
		return content
	}
	lines := []string{"# Files mentioned by the user:"}
	for _, attachment := range attachments {
		name := strings.TrimSpace(attachment.DisplayName)
		if name == "" {
			name = filepath.Base(attachment.AbsolutePath)
		}
		path := strings.TrimSpace(attachment.AbsolutePath)
		if path == "" {
			path = strings.TrimSpace(attachment.RelativePath)
		}
		if name != "" && path != "" {
			lines = append(lines, fmt.Sprintf("\n## %s: %s", name, path))
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n") + "\n\n## My request for Codex:\n\n" + content)
}

func workspacePromptPreview(content string) string {
	content = strings.Join(strings.Fields(strings.TrimSpace(content)), " ")
	const limit = 180
	if len([]rune(content)) <= limit {
		return content
	}
	return string([]rune(content)[:limit]) + "…"
}

func escapeWorkspaceXML(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, `"`, "&quot;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	value = strings.ReplaceAll(value, ">", "&gt;")
	return value
}

func createWorkspaceCodexLogFile() (*boundedlog.File, string) {
	logDir := filepath.Join(state.GetStateDir(), "logs")
	now := time.Now()
	name := fmt.Sprintf("codex-workspace-%s-%d-%d.log", now.Format("20060102-150405"), os.Getpid(), now.UnixNano())
	file, logPath, err := boundedlog.Open(logDir, "codex-workspace-", name)
	if err != nil {
		return nil, ""
	}
	return file, logPath
}

func optionalWorkspaceString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func isWorkspaceRecoverableCodexResumeError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "thread not found") ||
		strings.Contains(message, "not found") ||
		strings.Contains(message, "unknown thread") ||
		strings.Contains(message, "failed to deserialize stored thread item") ||
		strings.Contains(message, "unknown variant `completed`") ||
		strings.Contains(message, "stored thread item") ||
		strings.Contains(message, "method not found")
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func derefWorkspaceString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func firstNonEmptyWorkspaceString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

var workspaceCodexSecretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization\s*[:=]\s*bearer\s+)[^\s"']+`),
	regexp.MustCompile(`(?i)(api[_-]?key\s*[:=]\s*)[^\s"']+`),
	regexp.MustCompile(`(?i)(token\s*[:=]\s*)[^\s"']+`),
	regexp.MustCompile(`sk-[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`gh[pousr]_[A-Za-z0-9_]{8,}`),
}

func redactWorkspaceCodexJSON(data []byte) string {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return redactWorkspaceCodexText(string(data))
	}
	redacted, err := json.Marshal(redactWorkspaceCodexValue(value))
	if err != nil {
		return "[unserializable redacted payload]"
	}
	return string(redacted)
}

func redactWorkspaceCodexValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if isWorkspaceCodexSensitiveLogKey(key) || isWorkspaceCodexContentLogKey(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = redactWorkspaceCodexValue(item)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, redactWorkspaceCodexValue(item))
		}
		return out
	case string:
		return redactWorkspaceCodexText(typed)
	default:
		return typed
	}
}

func isWorkspaceCodexSensitiveLogKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "apikey", "api_key", "api-key", "authorization", "access_token", "accesstoken", "refresh_token", "refreshtoken", "secret", "password", "token":
		return true
	default:
		return false
	}
}

func isWorkspaceCodexContentLogKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "input", "text", "text_elements":
		return true
	default:
		return false
	}
}

func redactWorkspaceCodexText(text string) string {
	redacted := text
	for _, pattern := range workspaceCodexSecretPatterns {
		redacted = pattern.ReplaceAllStringFunc(redacted, func(match string) string {
			for _, separator := range []string{"Bearer ", "bearer ", "=", ":"} {
				if index := strings.LastIndex(match, separator); index >= 0 {
					return match[:index+len(separator)] + "[redacted]"
				}
			}
			return "[redacted]"
		})
	}
	return redacted
}
