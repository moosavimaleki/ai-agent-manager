package account

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"abolqasem/internal/codexmanager/auth"
	"abolqasem/internal/codexmanager/history"
	"abolqasem/internal/codexmanager/limits"
	"abolqasem/internal/codexmanager/storage"
)

func authFixture(subject string) map[string]any {
	return map[string]any{
		"tokens": map[string]any{
			"refresh_token": "redacted",
			"id_token":      tokenWithClaims(map[string]any{"sub": subject}),
		},
	}
}

func authFixtureWithAccess(subject, refresh string, expiry time.Time) map[string]any {
	raw := authFixture(subject)
	tokens := raw["tokens"].(map[string]any)
	tokens["refresh_token"] = refresh
	tokens["access_token"] = tokenWithClaims(map[string]any{"exp": expiry.Unix()})
	return raw
}

func tokenWithClaims(claims map[string]any) string {
	payload, _ := json.Marshal(claims)
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

func TestRepositoryCRUDAndActiveSafety(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	ctx := context.Background()
	if err := repo.Add(ctx, "alpha", authFixture("one"), false); err != nil {
		t.Fatal(err)
	}
	if err := repo.Add(ctx, "alpha", authFixture("one"), false); !errors.Is(err, ErrAccountExists) {
		t.Fatalf("duplicate add error = %v", err)
	}
	names, err := repo.List()
	if err != nil || len(names) != 1 || names[0] != "alpha" {
		t.Fatalf("names = %v, err = %v", names, err)
	}
	if err := repo.Activate(ctx, "alpha"); err != nil {
		t.Fatal(err)
	}
	if err := repo.Rename(ctx, "alpha", "beta"); err != nil {
		t.Fatal(err)
	}
	if active, err := repo.Active(); err != nil || active != "beta" {
		t.Fatalf("active = %q, err = %v", active, err)
	}
	if err := repo.Delete(ctx, "beta", false); !errors.Is(err, ErrAccountActive) {
		t.Fatalf("active delete error = %v", err)
	}
	if err := repo.Add(ctx, "gamma", authFixture("two"), false); err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(ctx, "gamma", false, true); !errors.Is(err, ErrAccountInUse) {
		t.Fatalf("in-use delete error = %v", err)
	}
	if err := repo.Delete(ctx, "gamma", true); !errors.Is(err, ErrAccountPinned) {
		t.Fatalf("pinned delete error = %v", err)
	}
	if err := repo.Delete(ctx, "gamma", false); err != nil {
		t.Fatal(err)
	}
}

func TestSyncRejectsIdentityChange(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	ctx := context.Background()
	if err := repo.Add(ctx, "alpha", authFixture("one"), false); err != nil {
		t.Fatal(err)
	}
	if err := repo.Sync(ctx, "alpha", authFixture("two")); err == nil {
		t.Fatal("expected identity mismatch")
	}
	if err := repo.Sync(ctx, "alpha", authFixture("one")); err != nil {
		t.Fatal(err)
	}
}

func TestAddRejectsASecondNameForTheSameIdentity(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	if err := repo.Add(context.Background(), "first", authFixture("one"), false); err != nil {
		t.Fatal(err)
	}
	if err := repo.Add(context.Background(), "second", authFixture("one"), false); !errors.Is(err, ErrAccountIdentity) {
		t.Fatalf("duplicate identity error = %v", err)
	}
}

func TestMarkVerificationPendingPreservesLastKnownQuota(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	ctx := context.Background()
	if err := repo.Add(ctx, "alpha", authFixture("one"), false); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	previous := &limits.Snapshot{
		Account:   "alpha",
		FetchedAt: now.Add(-time.Minute),
		Limits: []limits.Limit{{
			ID:      "codex",
			Windows: []limits.Window{{Label: "weekly", RemainingPercent: 66}},
		}},
	}
	if err := repo.RecordCheckStatus(ctx, "alpha", StateReady, "", now.Add(-time.Minute), previous); err != nil {
		t.Fatal(err)
	}
	if err := repo.MarkVerificationPending(ctx, "alpha", now); err != nil {
		t.Fatal(err)
	}
	status, err := repo.Status("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != StateStale || status.RateLimits == nil || len(status.RateLimits.Limits) != 1 || status.RateLimits.Limits[0].Windows[0].RemainingPercent != 66 {
		t.Fatalf("activation must retain the previous quota while checking: %#v", status)
	}
}

func TestRenameMovesStatusAndHistoryInOneManagerTransaction(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	ctx := context.Background()
	if err := repo.Add(ctx, "alpha", authFixture("one"), false); err != nil {
		t.Fatal(err)
	}
	status, err := repo.Paths.Status("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.WriteJSON(repo.Paths, status, map[string]any{"state": "ready"}); err != nil {
		t.Fatal(err)
	}
	store := history.Store{Paths: repo.Paths}
	if _, err := store.Append(ctx, limits.Snapshot{Account: "alpha", FetchedAt: time.Now().UTC(), Limits: []limits.Limit{{ID: "codex", Windows: []limits.Window{{Label: "weekly", RemainingPercent: 50}}}}}); err != nil {
		t.Fatal(err)
	}
	if err := repo.Rename(ctx, "alpha", "beta"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Paths.Status("beta"); err != nil {
		t.Fatalf("status was not moved: %v", err)
	}
	rows, err := store.Read("beta", time.Time{}, 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("history was not moved: rows=%#v err=%v", rows, err)
	}
}

func TestSyncLiveImportsAndPromotesOnlyNewerMatchingAuth(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	livePath := filepath.Join(t.TempDir(), "auth.json")
	live := authFixture("one")
	live["tokens"].(map[string]any)["refresh_token"] = "live-refresh"
	live["email"] = "person@example.com"
	data, err := json.Marshal(live)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(livePath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := repo.SyncLive(context.Background(), livePath)
	if err != nil || !first.Imported || first.Name != "person" {
		t.Fatalf("first live sync = %#v, %v", first, err)
	}
	stored, err := repo.Read("person")
	if err != nil || stored["tokens"].(map[string]any)["refresh_token"] != "live-refresh" {
		t.Fatalf("stored live auth = %#v, %v", stored, err)
	}
	stored["tokens"].(map[string]any)["refresh_token"] = "manager-refresh"
	if err := repo.Sync(context.Background(), "person", stored); err != nil {
		t.Fatal(err)
	}
	second, err := repo.SyncLive(context.Background(), livePath)
	if err != nil || !second.Promoted || second.Name != "person" {
		t.Fatalf("second live sync = %#v, %v", second, err)
	}
	if active, err := repo.Active(); err != nil || active != "person" {
		t.Fatalf("active = %q, %v", active, err)
	}
}

func TestActivateLiveReplacesOnlyTheSelectedLiveAuth(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	if err := repo.Add(context.Background(), "selected", authFixture("selected"), false); err != nil {
		t.Fatal(err)
	}
	livePath := filepath.Join(t.TempDir(), "auth.json")
	if err := repo.ActivateLive(context.Background(), "selected", livePath); err != nil {
		t.Fatal(err)
	}
	live, err := readAuthFile(livePath)
	if err != nil || auth.Identity(live)["subject"] != "selected" {
		t.Fatalf("live auth = %#v, %v", live, err)
	}
	if active, err := repo.Active(); err != nil || active != "selected" {
		t.Fatalf("active = %q, %v", active, err)
	}
}

func TestSyncLiveReconcilesDuplicateIdentityUsingFreshestCredential(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	now := time.Now().UTC()
	if err := repo.Add(context.Background(), "first", authFixtureWithAccess("one", "expired", now.Add(-time.Hour)), false); err != nil {
		t.Fatal(err)
	}
	secondPath, err := repo.Paths.Account("second")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.WriteJSON(repo.Paths, secondPath, authFixtureWithAccess("one", "also-expired", now.Add(-time.Hour))); err != nil {
		t.Fatal(err)
	}
	if err := repo.Activate(context.Background(), "second"); err != nil {
		t.Fatal(err)
	}
	livePath := filepath.Join(t.TempDir(), "auth.json")
	fresh := authFixtureWithAccess("one", "fresh-live", now.Add(time.Hour))
	if err := writeAuthFile(livePath, fresh); err != nil {
		t.Fatal(err)
	}
	result, err := repo.SyncLive(context.Background(), livePath)
	if err != nil || result.Name != "second" || !result.Promoted {
		t.Fatalf("sync result=%#v err=%v", result, err)
	}
	for _, name := range []string{"first", "second"} {
		stored, readErr := repo.Read(name)
		if readErr != nil || stored["tokens"].(map[string]any)["refresh_token"] != "fresh-live" {
			t.Fatalf("%s was not reconciled: %#v, %v", name, stored, readErr)
		}
	}
}

func TestSyncLiveRestoresStoredCredentialWhenLiveIsExpired(t *testing.T) {
	repo := Repository{Paths: storage.Paths{Home: t.TempDir()}}
	now := time.Now().UTC()
	if err := repo.Add(context.Background(), "selected", authFixtureWithAccess("one", "managed-fresh", now.Add(time.Hour)), false); err != nil {
		t.Fatal(err)
	}
	livePath := filepath.Join(t.TempDir(), "auth.json")
	if err := writeAuthFile(livePath, authFixtureWithAccess("one", "live-expired", now.Add(-time.Hour))); err != nil {
		t.Fatal(err)
	}
	result, err := repo.SyncLive(context.Background(), livePath)
	if err != nil || result.Promoted {
		t.Fatalf("sync result=%#v err=%v", result, err)
	}
	live, readErr := readAuthFile(livePath)
	if readErr != nil || live["tokens"].(map[string]any)["refresh_token"] != "managed-fresh" {
		t.Fatalf("live auth was not restored: %#v, %v", live, readErr)
	}
}
