package server

import (
	"context"
	"sync"
	"time"

	"abolqasem/internal/codexmanager"
	"abolqasem/internal/codexmanager/maintenance"
	"abolqasem/internal/state"
)

// These mirror the original Codex Manager defaults. The persisted settings
// below may change them while the server remains running.
const (
	codexManagerMaintenanceInterval = 15 * time.Minute
	codexManagerMaintenanceJitter   = 5 * time.Minute
	codexManagerHistoryRetention    = 90 * 24 * time.Hour
	codexManagerMaintenancePoll     = time.Minute
)

var newCodexManagerMaintenanceManager = codexmanager.New
var loadCodexManagerMaintenanceSettings = state.LoadSettings

var codexManagerMaintenanceRuntime = struct {
	sync.RWMutex
	Running   bool
	NextRun   time.Time
	LastRun   time.Time
	LastError string
}{}

func codexManagerMaintenanceWorkerStatus() map[string]any {
	codexManagerMaintenanceRuntime.RLock()
	defer codexManagerMaintenanceRuntime.RUnlock()
	return map[string]any{
		"running":   codexManagerMaintenanceRuntime.Running,
		"nextRun":   codexManagerMaintenanceRuntime.NextRun,
		"lastRun":   codexManagerMaintenanceRuntime.LastRun,
		"lastError": codexManagerMaintenanceRuntime.LastError,
	}
}

func setCodexManagerMaintenanceWorkerStatus(running bool, nextRun, lastRun time.Time, lastError string) {
	codexManagerMaintenanceRuntime.Lock()
	codexManagerMaintenanceRuntime.Running = running
	codexManagerMaintenanceRuntime.NextRun = nextRun
	codexManagerMaintenanceRuntime.LastRun = lastRun
	codexManagerMaintenanceRuntime.LastError = lastError
	codexManagerMaintenanceRuntime.Unlock()
}

// rescheduleCodexManagerMaintenanceWorker keeps the most recent check result
// visible while the timer is recalculated after a settings change. Otherwise a
// harmless interval edit would make diagnostics look as if the worker had
// never run.
func rescheduleCodexManagerMaintenanceWorker(nextRun time.Time) {
	codexManagerMaintenanceRuntime.Lock()
	codexManagerMaintenanceRuntime.Running = true
	codexManagerMaintenanceRuntime.NextRun = nextRun
	codexManagerMaintenanceRuntime.Unlock()
}

// stopCodexManagerMaintenanceWorker deliberately retains LastRun and
// LastError. They describe the last completed attempt, including after a
// graceful shutdown, while Running and NextRun describe the current state.
func stopCodexManagerMaintenanceWorker() {
	codexManagerMaintenanceRuntime.Lock()
	codexManagerMaintenanceRuntime.Running = false
	codexManagerMaintenanceRuntime.NextRun = time.Time{}
	codexManagerMaintenanceRuntime.Unlock()
}

type codexManagerMaintenanceConfig struct {
	Interval  time.Duration
	Jitter    time.Duration
	Retention time.Duration
	ProxyURL  string
}

func loadCodexManagerMaintenanceConfig() codexManagerMaintenanceConfig {
	settings, err := loadCodexManagerMaintenanceSettings()
	if err != nil {
		settings = state.DefaultAppSettings()
	}
	value := settings.CodexBackend.Maintenance
	interval := time.Duration(value.IntervalSeconds) * time.Second
	if interval < 5*time.Minute || interval > 7*24*time.Hour {
		interval = codexManagerMaintenanceInterval
	}
	jitter := time.Duration(value.JitterSeconds) * time.Second
	if jitter < 0 || jitter > time.Hour || jitter > interval {
		jitter = 0
	}
	retention := time.Duration(value.RetentionDays) * 24 * time.Hour
	if retention <= 0 {
		retention = codexManagerHistoryRetention
	}
	return codexManagerMaintenanceConfig{
		Interval:  interval,
		Jitter:    jitter,
		Retention: retention,
		ProxyURL:  value.ProxyURL,
	}
}

func (c codexManagerMaintenanceConfig) nextDelay(now time.Time) time.Duration {
	delay := c.Interval
	if c.Jitter > 0 {
		delay += time.Duration(now.UnixNano() % int64(c.Jitter+1))
	}
	return delay
}

// startCodexManagerMaintenance owns the in-process background worker. It
// polls only its lightweight persisted configuration once a minute, so a UI
// change reschedules the next check without a service restart. The check is
// deliberately not run at startup: server readiness must remain immediate.
func startCodexManagerMaintenance(parent context.Context) func() {
	manager := newCodexManagerMaintenanceManager(codexManagerPaths())
	initial := loadCodexManagerMaintenanceConfig()
	// Set the initial values before the first timer tick as well. Besides
	// making the worker inspectable at startup, this makes a manual Check use
	// exactly the same persisted proxy/retention settings as the scheduler.
	manager.Maintenance.Config = maintenance.Config{IncludeActive: true, Retention: initial.Retention, ProxyURL: initial.ProxyURL}
	manager.BeforeCheck = func(ctx context.Context) error {
		_, err := syncCodexManagerLiveAccount(ctx, manager.Accounts)
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		defer stopCodexManagerMaintenanceWorker()
		now := time.Now()
		config := initial
		// The first background pass should not wait a full interval after a
		// restart. It is still asynchronous, so server readiness is unaffected.
		nextRun := now
		rescheduleCodexManagerMaintenanceWorker(nextRun)
		ticker := time.NewTicker(codexManagerMaintenancePoll)
		defer ticker.Stop()
		// Start the first check in this background worker immediately. The HTTP
		// server is already accepting requests, so startup never waits for it.
		wake := make(chan time.Time, 1)
		wake <- now
		for {
			select {
			case <-ctx.Done():
				return
			case now = <-wake:
			case now = <-ticker.C:
				nextConfig := loadCodexManagerMaintenanceConfig()
				if nextConfig != config {
					config = nextConfig
					nextRun = now.Add(config.nextDelay(now))
					rescheduleCodexManagerMaintenanceWorker(nextRun)
				}
				if now.Before(nextRun) {
					continue
				}
				manager.Maintenance.Config = maintenance.Config{IncludeActive: true, Retention: config.Retention, ProxyURL: config.ProxyURL}
				lastError := ""
				for attempt, backoff := 0, time.Second; attempt < 3; attempt, backoff = attempt+1, minDuration(backoff*2, 15*time.Minute) {
					if _, err := manager.Check(ctx); err == nil || ctx.Err() != nil {
						if err != nil {
							lastError = err.Error()
						}
						break
					} else {
						lastError = err.Error()
					}
					select {
					case <-ctx.Done():
						return
					case <-time.After(backoff):
					}
				}
				nextRun = time.Now().Add(config.nextDelay(time.Now()))
				setCodexManagerMaintenanceWorkerStatus(true, nextRun, time.Now().UTC(), lastError)
			}
		}
	}()
	return func() {
		cancel()
		wait.Wait()
	}
}

func minDuration(left, right time.Duration) time.Duration {
	if left < right {
		return left
	}
	return right
}
