package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"abolqasem/internal/codexmanager"
	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/maintenance"
)

var codexManagerLiveAuthRoot = workspaceCodexRootDir

var startCodexManagerPostSwitchCheck = checkCodexManagerAccountAfterSwitch

func codexManagerLiveAuthPath() string { return filepath.Join(codexManagerLiveAuthRoot(), "auth.json") }

// syncCodexManagerLiveAccount imports the active native Codex identity the
// first time it is seen and promotes tokens only if the live file is newer.
func syncCodexManagerLiveAccount(ctx context.Context, repository account.Repository) (account.LiveSyncResult, error) {
	return repository.SyncLive(ctx, codexManagerLiveAuthPath())
}

func newCodexManagerCheckManager() *codexmanager.Manager {
	manager := codexmanager.New(codexManagerPaths())
	config := loadCodexManagerMaintenanceConfig()
	manager.Maintenance.Config = maintenance.Config{IncludeActive: true, Retention: config.Retention, ProxyURL: config.ProxyURL}
	manager.BeforeCheck = func(checkCtx context.Context) error {
		_, err := syncCodexManagerLiveAccount(checkCtx, manager.Accounts)
		return err
	}
	return manager
}

// switchCodexManagerLiveAccount makes manual account switching transactional
// from the user's perspective: no running turn is disrupted; live auth.json
// is first reconciled, then replaced, then every idle app-server is reset so
// the next request necessarily starts under the newly selected identity.
func switchCodexManagerLiveAccount(ctx context.Context, repository account.Repository, name string) error {
	_, err := switchCodexManagerLiveAccountWithResult(ctx, repository, name)
	return err
}

// switchCodexManagerLiveAccountWithResult reports whether the live auth file's
// actual contents changed. A successful activation of the already-live account
// is valid, but callers must not present it as an identity change.
func switchCodexManagerLiveAccountWithResult(ctx context.Context, repository account.Repository, name string) (bool, error) {
	workspaceCodexCredentialSwitch.Lock()
	defer workspaceCodexCredentialSwitch.Unlock()
	liveAuthPath := codexManagerLiveAuthPath()
	before, err := readCodexManagerLiveAuth(liveAuthPath)
	if err != nil {
		return false, err
	}
	// This is local reconciliation only. It preserves a refresh token Codex
	// rotated in auth.json, but must never make switching away from a broken
	// account impossible.
	_, _ = syncCodexManagerLiveAccount(ctx, repository)
	if err := repository.ActivateLive(ctx, name, liveAuthPath); err != nil {
		return false, err
	}
	if err := repository.MarkVerificationPending(ctx, name, time.Now().UTC()); err != nil {
		return false, fmt.Errorf("mark activated account for verification: %w", err)
	}
	after, err := readCodexManagerLiveAuth(liveAuthPath)
	if err != nil {
		return false, err
	}
	workspaceCodexSessions.resetForCredentialSwitch()
	// Network refresh/quota checks intentionally happen after auth.json is
	// ready and outside the request path. New sessions can start immediately.
	go startCodexManagerPostSwitchCheck(name)
	return !bytes.Equal(before, after), nil
}

func readCodexManagerLiveAuth(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func checkCodexManagerAccountAfterSwitch(name string) {
	manager := newCodexManagerCheckManager()
	manager.Maintenance.Config.IncludeActive = true
	manager.Maintenance.Config.Accounts = []string{name}
	_, _ = manager.Check(context.Background())
}
