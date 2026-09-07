package codexmanager

import (
	"context"
	"errors"
	"sync"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/browser"
	"abolqasem/internal/codexmanager/history"
	"abolqasem/internal/codexmanager/limits"
	"abolqasem/internal/codexmanager/login"
	"abolqasem/internal/codexmanager/maintenance"
	"abolqasem/internal/codexmanager/recommendation"
	"abolqasem/internal/codexmanager/storage"
)

// Manager is the only integration point exposed to the HTTP/API layer. It
// owns all workers so application shutdown is deterministic.
type Manager struct {
	Paths       storage.Paths
	Accounts    account.Repository
	Limits      limits.Client
	History     history.Store
	Maintenance maintenance.Service
	Login       login.Service
	Browser     browser.DeviceClient
	// BeforeCheck is an optional integration hook used by the host to reconcile
	// a live credential source before maintenance reads the managed copy.
	// The domain package never assumes where that live source resides.
	BeforeCheck func(context.Context) error

	mu     sync.Mutex
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func New(paths storage.Paths) *Manager {
	accounts := account.Repository{Paths: paths}
	historyStore := history.Store{Paths: paths}
	return &Manager{Paths: paths, Accounts: accounts, History: historyStore, Maintenance: maintenance.Service{Accounts: accounts, History: historyStore}}
}

func (m *Manager) Start(parent context.Context, scheduler *maintenance.Scheduler) {
	m.mu.Lock()
	if m.cancel != nil {
		m.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	m.cancel = cancel
	m.mu.Unlock()
	if scheduler == nil {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		scheduler.Start(ctx, func(runCtx context.Context) error {
			_, err := m.Check(runCtx)
			return err
		})
		<-ctx.Done()
	}()
}

func (m *Manager) Shutdown() {
	m.mu.Lock()
	cancel := m.cancel
	m.cancel = nil
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	m.wg.Wait()
}

func (m *Manager) Check(ctx context.Context) (maintenance.Summary, error) {
	if m.BeforeCheck != nil {
		if err := m.BeforeCheck(ctx); err != nil {
			return maintenance.Summary{}, err
		}
	}
	return m.Maintenance.Run(ctx)
}

func (m *Manager) Recommendation(now time.Time) (recommendation.Selection, error) {
	names, err := m.Accounts.List()
	if err != nil {
		return recommendation.Selection{}, err
	}
	candidates := make([]recommendation.Candidate, 0, len(names))
	for _, name := range names {
		credentials, readErr := m.Accounts.Read(name)
		if readErr != nil {
			continue
		}
		status, statusErr := m.Accounts.Status(name)
		if statusErr != nil {
			// A damaged status file is never a reason to resurrect historical
			// quota data. Surface it as stale until an explicit check repairs it.
			status = account.Status{State: account.StateStale, Message: "account status is unreadable; verify it again"}
		}
		metadata := accountMetadata(credentials)
		limitSnapshot := recommendation.EmptySnapshot(name)
		if status.RateLimits != nil {
			limitSnapshot = *status.RateLimits
		}
		candidates = append(candidates, recommendation.Candidate{Name: name, Plan: metadata.plan, State: status.State, Limits: limitSnapshot})
	}
	return recommendation.Select(candidates, now), nil
}

func (m *Manager) BrowserCleanup(ctx context.Context, managed account.Account, client browser.DeviceClient, policy browser.CleanupPolicy) browser.CleanupResult {
	return browser.Cleanup(ctx, managed, client, policy)
}

// BrowserDevices and RevokeBrowserDevice keep browser session operations on
// the same facade as accounts and maintenance. A nil client is treated as a
// configuration error rather than silently doing nothing.
func (m *Manager) BrowserDevices(ctx context.Context) ([]browser.Device, error) {
	if m.Browser == nil {
		return nil, errors.New("browser session client is not configured")
	}
	return m.Browser.Devices(ctx)
}

func (m *Manager) RevokeBrowserDevice(ctx context.Context, device browser.Device) error {
	if m.Browser == nil {
		return errors.New("browser session client is not configured")
	}
	return m.Browser.Revoke(ctx, device)
}

type metadata struct{ plan account.Plan }

func accountMetadata(raw map[string]any) metadata {
	tokens, _ := raw["tokens"].(map[string]any)
	plan, _ := tokens["plan"].(string)
	if plan == "free" {
		return metadata{plan: account.PlanFree}
	}
	if plan == "plus" {
		return metadata{plan: account.PlanPlus}
	}
	return metadata{plan: account.PlanUnknown}
}
