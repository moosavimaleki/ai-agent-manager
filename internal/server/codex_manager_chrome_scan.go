package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/browser"
	"abolqasem/internal/codexmanager/storage"
	"abolqasem/internal/state"
)

// Chrome sign-in state is useful even when the account cleanup monitor is
// disabled. The scan has a fixed, conservative cadence: it keeps the profile
// table accurate without giving the user another scheduling knob to manage.
const codexManagerChromeScanInterval = 15 * time.Minute

type codexManagerChromeScanSnapshot struct {
	Profiles  []map[string]any `json:"profiles"`
	ScannedAt time.Time        `json:"scannedAt"`
}

var codexManagerChromeScanRuntime = struct {
	sync.RWMutex
	Snapshot codexManagerChromeScanSnapshot
	Loaded   bool
}{}

func codexManagerChromeScanPath() string {
	return filepath.Join(codexManagerPaths().Home, "chrome-scan.json")
}

func codexManagerChromeScanCached() (codexManagerChromeScanSnapshot, bool) {
	codexManagerChromeScanRuntime.RLock()
	if codexManagerChromeScanRuntime.Loaded && !codexManagerChromeScanRuntime.Snapshot.ScannedAt.IsZero() {
		value := codexManagerChromeScanRuntime.Snapshot
		codexManagerChromeScanRuntime.RUnlock()
		return value, true
	}
	codexManagerChromeScanRuntime.RUnlock()

	var value codexManagerChromeScanSnapshot
	if err := storage.ReadJSON(codexManagerChromeScanPath(), &value); err != nil || value.ScannedAt.IsZero() {
		return codexManagerChromeScanSnapshot{}, false
	}
	codexManagerChromeScanRuntime.Lock()
	if !codexManagerChromeScanRuntime.Loaded || codexManagerChromeScanRuntime.Snapshot.ScannedAt.Before(value.ScannedAt) {
		codexManagerChromeScanRuntime.Snapshot = value
	}
	codexManagerChromeScanRuntime.Loaded = true
	value = codexManagerChromeScanRuntime.Snapshot
	codexManagerChromeScanRuntime.Unlock()
	return value, true
}

func codexManagerStoreChromeScan(value codexManagerChromeScanSnapshot) {
	codexManagerChromeScanRuntime.Lock()
	codexManagerChromeScanRuntime.Snapshot = value
	codexManagerChromeScanRuntime.Loaded = true
	codexManagerChromeScanRuntime.Unlock()
	// A cache write failure must never discard a successful in-memory scan.
	_ = storage.WriteJSON(codexManagerPaths(), codexManagerChromeScanPath(), value)
}

// startCodexManagerChromeScanWorker refreshes the status table shortly after
// startup and then every fifteen minutes. It has no user-controlled cleanup
// behavior: it only reads local cookies and the current ChatGPT sign-in.
func startCodexManagerChromeScanWorker(parent context.Context) func() {
	ctx, cancel := context.WithCancel(parent)
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		run := func() {
			scanCtx, scanCancel := context.WithTimeout(ctx, 45*time.Second)
			defer scanCancel()
			_, _ = codexManagerRefreshChromeScan(scanCtx)
		}
		// Do the initial scan asynchronously. Server readiness and chat loading
		// must not wait for potentially locked Chrome profiles.
		run()
		ticker := time.NewTicker(codexManagerChromeScanInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
	return func() {
		cancel()
		wait.Wait()
	}
}

func codexManagerRefreshChromeScan(ctx context.Context) (codexManagerChromeScanSnapshot, error) {
	profiles, err := codexManagerBrowserProfiles()
	if err != nil {
		return codexManagerChromeScanSnapshot{}, err
	}
	settings, err := state.LoadSettings()
	if err != nil {
		settings = state.DefaultAppSettings()
	}
	accounts := redactCodexManagerAccounts(account.Repository{Paths: codexManagerPaths()})
	managed := make(map[string]account.Account)
	historical := make(map[string][]account.Account)
	for _, item := range accounts {
		if email := strings.ToLower(strings.TrimSpace(item.Email)); email != "" {
			managed[email] = item
		}
		if item.ChromeProfile != nil && item.ChromeProfile.ID != "" {
			historical[item.ChromeProfile.ID] = append(historical[item.ChromeProfile.ID], item)
		}
	}
	items := make([]map[string]any, len(profiles))
	semaphore := make(chan struct{}, 3)
	var wait sync.WaitGroup
	for index, profile := range profiles {
		wait.Add(1)
		go func(index int, profile browser.Profile) {
			defer wait.Done()
			select {
			case semaphore <- struct{}{}:
			case <-ctx.Done():
				items[index] = map[string]any{"id": profile.ID, "name": profile.Name, "outcome": "error", "reason": "scan cancelled"}
				return
			}
			defer func() { <-semaphore }()
			items[index] = codexManagerScanChromeProfile(ctx, profile, managed, historical[profile.ID], settings.CodexBackend.Maintenance.ProxyURL)
		}(index, profile)
	}
	wait.Wait()
	if err := ctx.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return codexManagerChromeScanSnapshot{}, err
	}
	items = codexManagerAppendMissingChromeProfiles(items, accounts)
	value := codexManagerChromeScanSnapshot{Profiles: items, ScannedAt: time.Now().UTC()}
	if err := codexManagerStoreChromeProfileAssociations(value); err != nil {
		return codexManagerChromeScanSnapshot{}, err
	}
	codexManagerStoreChromeScan(value)
	return value, nil
}

// codexManagerAppendMissingChromeProfiles keeps historical associations in the
// Chrome table when a profile was deleted, moved, or no longer has a cookie
// database. It is a read-only UI projection: opening such a row still fails
// safely until Chrome recreates that profile.
func codexManagerAppendMissingChromeProfiles(profiles []map[string]any, accounts []account.Account) []map[string]any {
	known := make(map[string]int, len(profiles))
	for index, profile := range profiles {
		if id, _ := profile["id"].(string); id != "" {
			known[id] = index
		}
	}
	for _, item := range accounts {
		association := item.ChromeProfile
		if association == nil || association.ID == "" || association.Name == "" {
			continue
		}
		if index, exists := known[association.ID]; exists {
			profile := profiles[index]
			if profile["outcome"] == "missing" {
				linked, _ := profile["accounts"].(map[string]string)
				if linked == nil {
					linked = map[string]string{}
				}
				if email := strings.ToLower(strings.TrimSpace(item.Email)); email != "" {
					linked[email] = item.Name
				}
				profile["accounts"] = linked
			}
			continue
		}
		email := strings.ToLower(strings.TrimSpace(item.Email))
		linked := map[string]string{}
		if email != "" {
			linked[email] = item.Name
		}
		profiles = append(profiles, map[string]any{
			"id":                 association.ID,
			"name":               association.Name,
			"outcome":            "missing",
			"reason":             "Chrome profile is no longer available on this device",
			"accounts":           linked,
			"lastActiveEmail":    association.LastActiveEmail,
			"lastManagedAccount": association.LastManagedAccount,
		})
		known[association.ID] = len(profiles) - 1
	}
	return profiles
}

// codexManagerStoreChromeProfileAssociations retains the last profile known
// for every managed account. A subsequent scan updates its outcome even if a
// different ChatGPT account is now signed in, which makes a broken/moved
// profile visible instead of making the association disappear.
func codexManagerStoreChromeProfileAssociations(snapshot codexManagerChromeScanSnapshot) error {
	paths := codexManagerPaths()
	repository := account.Repository{Paths: paths}
	accounts := redactCodexManagerAccounts(repository)
	profilesByID := make(map[string]map[string]any, len(snapshot.Profiles))
	linked := make(map[string]map[string]any)
	for _, profile := range snapshot.Profiles {
		id, _ := profile["id"].(string)
		if id != "" {
			profilesByID[id] = profile
		}
		if name, _ := profile["managedAccount"].(string); name != "" {
			linked[name] = profile
		}
		if accounts, _ := profile["accounts"].(map[string]string); accounts != nil {
			for _, name := range accounts {
				if _, found := linked[name]; !found && name != "" {
					linked[name] = profile
				}
			}
		}
		if name, _ := profile["lastManagedAccount"].(string); name != "" {
			if _, found := linked[name]; !found {
				linked[name] = profile
			}
		}
	}
	for _, item := range accounts {
		path, err := paths.Status(item.Name)
		if err != nil {
			continue
		}
		var status map[string]any
		if err := storage.ReadJSON(path, &status); err != nil {
			// A missing status file is expected for a newly imported account;
			// a malformed existing status must not be silently overwritten.
			if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			status = map[string]any{}
		}
		if status == nil {
			status = map[string]any{}
		}
		previous, _ := status["chrome_profile"].(map[string]any)
		profile := linked[item.Name]
		if profile == nil && previous != nil {
			if id, _ := previous["id"].(string); id != "" {
				profile = profilesByID[id]
			}
		}
		if profile == nil {
			if previous == nil {
				continue
			}
			previous["outcome"] = "missing"
			previous["lastCheckedAt"] = snapshot.ScannedAt
			status["chrome_profile"] = previous
			if err := storage.WriteJSON(paths, path, status); err != nil {
				return err
			}
			continue
		}
		id, _ := profile["id"].(string)
		name, _ := profile["name"].(string)
		outcome, _ := profile["outcome"].(string)
		activeEmail, _ := profile["activeEmail"].(string)
		if managedName, _ := profile["managedAccount"].(string); managedName != item.Name && outcome == "signed_in" {
			// The profile still works, but it is signed in as somebody else. Keep
			// the historical association and make the mismatch explicit to the UI.
			outcome = "changed"
		}
		entry := map[string]any{"id": id, "name": name, "outcome": outcome, "activeEmail": activeEmail, "lastCheckedAt": snapshot.ScannedAt}
		if lastActiveEmail, _ := profile["lastActiveEmail"].(string); lastActiveEmail != "" {
			entry["lastActiveEmail"] = lastActiveEmail
		}
		if lastManagedAccount, _ := profile["lastManagedAccount"].(string); lastManagedAccount != "" {
			entry["lastManagedAccount"] = lastManagedAccount
		}
		if linked[item.Name] != nil {
			entry["lastSeenAt"] = snapshot.ScannedAt
		} else if previous != nil {
			entry["lastSeenAt"] = previous["lastSeenAt"]
		}
		status["chrome_profile"] = entry
		if err := storage.WriteJSON(paths, path, status); err != nil {
			return err
		}
	}
	return nil
}
