package codexmanager

import (
	"context"
	"testing"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/browser"
	"abolqasem/internal/codexmanager/limits"
	"abolqasem/internal/codexmanager/maintenance"
	"abolqasem/internal/codexmanager/storage"
)

func TestManagerLifecycleAndAccountFacade(t *testing.T) {
	manager := New(storage.Paths{Home: t.TempDir()})
	if err := manager.Accounts.Add(context.Background(), "first", map[string]any{"tokens": map[string]any{"refresh_token": "refresh"}}, false); err != nil {
		t.Fatal(err)
	}
	if err := manager.Accounts.Activate(context.Background(), "first"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	manager.Start(ctx, &maintenance.Scheduler{Interval: time.Hour})
	manager.Shutdown()
	cancel()
	if active, err := manager.Accounts.Active(); err != nil || active != "first" {
		t.Fatalf("active=%q err=%v", active, err)
	}
	_ = account.PlanPlus
}

func TestManagerBrowserFacadeRequiresConfiguredClient(t *testing.T) {
	manager := New(storage.Paths{Home: t.TempDir()})
	if _, err := manager.BrowserDevices(context.Background()); err == nil {
		t.Fatal("expected unconfigured browser client error")
	}
	if err := manager.RevokeBrowserDevice(context.Background(), browser.Device{ID: "device"}); err == nil {
		t.Fatal("expected unconfigured browser client error")
	}
}

func TestRecommendationUsesLiveStatusNotHistoricalQuota(t *testing.T) {
	paths := storage.Paths{Home: t.TempDir()}
	manager := New(paths)
	ctx := context.Background()
	if err := manager.Accounts.Add(ctx, "stale", map[string]any{"tokens": map[string]any{"refresh_token": "refresh"}}, false); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	selection, err := manager.Recommendation(now)
	if err != nil || selection.Best != nil || selection.Results["stale"].Label != "stale" {
		t.Fatalf("selection=%#v err=%v", selection, err)
	}
	snapshot := limits.Snapshot{Account: "stale", FetchedAt: now, Limits: []limits.Limit{{ID: "codex", Windows: []limits.Window{{Label: "5h", RemainingPercent: 100, WindowMinutes: intPtr(300)}}}}}
	if err := manager.Accounts.RecordCheckStatus(ctx, "stale", account.StateReady, "live verification passed", now, &snapshot); err != nil {
		t.Fatal(err)
	}
	selection, err = manager.Recommendation(now)
	if err != nil || selection.Best == nil || selection.Best.Account != "stale" || !selection.Best.Recommendable {
		t.Fatalf("selection=%#v err=%v", selection, err)
	}
}

func intPtr(value int) *int { return &value }
