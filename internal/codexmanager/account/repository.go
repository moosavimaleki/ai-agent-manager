package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"abolqasem/internal/codexmanager/auth"
	"abolqasem/internal/codexmanager/history"
	"abolqasem/internal/codexmanager/limits"
	"abolqasem/internal/codexmanager/storage"
)

var (
	ErrAccountExists   = errors.New("account already exists")
	ErrAccountIdentity = errors.New("managed account identity already exists")
	ErrAccountActive   = errors.New("cannot delete the active account")
	ErrAccountPinned   = errors.New("cannot delete pinned account")
	ErrAccountInUse    = errors.New("cannot delete account used by an active turn")
	ErrMissingRefresh  = errors.New("missing refresh token")
)

// Repository owns the account inventory and performs tightly scoped, atomic
// synchronization with the one live Codex auth.json selected by the user.
type Repository struct {
	Paths storage.Paths
}

// LiveSyncResult describes a safe reconciliation of the auth.json currently
// used by Codex. No token material is ever returned to API callers.
type LiveSyncResult struct {
	Name     string
	Imported bool
	Promoted bool
}

type state struct {
	Active string `json:"active,omitempty"`
}

func (r Repository) Add(ctx context.Context, name string, raw map[string]any, force bool) error {
	path, err := r.Paths.Account(name)
	if err != nil {
		return err
	}
	if !hasRefreshToken(raw) {
		return ErrMissingRefresh
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		if _, err := os.Stat(path); err == nil && !force {
			return ErrAccountExists
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		// A second name for the same Codex identity makes live-auth sync
		// ambiguous. Reject it at the boundary rather than discovering it only
		// when the user tries to activate or refresh the account.
		names, listErr := r.listLocked()
		if listErr != nil {
			return listErr
		}
		for _, existingName := range names {
			if existingName == name {
				continue
			}
			existing, readErr := r.Read(existingName)
			if readErr != nil {
				continue
			}
			if same, _ := auth.SameIdentity(existing, raw); same {
				return fmt.Errorf("%w: %s", ErrAccountIdentity, existingName)
			}
		}
		return storage.WriteJSON(r.Paths, path, raw)
	})
}

func (r Repository) Read(name string) (map[string]any, error) {
	path, err := r.Paths.Account(name)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	err = storage.ReadJSON(path, &value)
	return value, err
}

// Status returns the one safe, persisted status projection for an account.
// A credential file merely proves that an account was imported; it does not
// prove that Codex can authenticate with it. Therefore a missing, corrupt, or
// unknown status is always reported as stale until a live quota check passes.
func (r Repository) Status(name string) (Status, error) {
	path, err := r.Paths.Status(name)
	if err != nil {
		return Status{State: StateStale, Message: "account has not been verified"}, err
	}
	var persisted struct {
		State                  string           `json:"state"`
		Message                string           `json:"message"`
		CheckedAt              time.Time        `json:"checked_at"`
		RateLimits             *limits.Snapshot `json:"rate_limits"`
		SessionMonitor         *SessionMonitor  `json:"session_monitor"`
		SessionMonitorDisabled bool             `json:"session_monitor_disabled"`
		ChromeProfile          *ChromeProfile   `json:"chrome_profile"`
	}
	if err := storage.ReadJSON(path, &persisted); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Status{State: StateStale, Message: "account has not been verified"}, nil
		}
		return Status{State: StateStale, Message: "account status is unreadable; verify it again"}, err
	}
	state := State(strings.TrimSpace(persisted.State))
	if state != StateReady && state != StateNeedsLogin && state != StateError && state != StateStale {
		state = StateStale
	}
	status := Status{
		State:                  state,
		Message:                strings.TrimSpace(persisted.Message),
		RateLimits:             persisted.RateLimits,
		SessionMonitor:         persisted.SessionMonitor,
		SessionMonitorDisabled: persisted.SessionMonitorDisabled,
		ChromeProfile:          persisted.ChromeProfile,
	}
	if !persisted.CheckedAt.IsZero() {
		checkedAt := persisted.CheckedAt.UTC()
		status.CheckedAt = &checkedAt
	}
	if status.Message == "" && state == StateStale {
		status.Message = "account has not been verified"
	}
	return status, nil
}

// RecordCheckStatus atomically replaces only the live-verification fields.
// Chrome/session-monitor metadata shares this file, so it is preserved rather
// than being accidentally erased by quota maintenance.
func (r Repository) RecordCheckStatus(ctx context.Context, name string, state State, message string, checkedAt time.Time, rateLimits *limits.Snapshot) error {
	if state != StateReady && state != StateNeedsLogin && state != StateError && state != StateStale {
		return fmt.Errorf("invalid account status %q", state)
	}
	path, err := r.Paths.Status(name)
	if err != nil {
		return err
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		payload := map[string]any{}
		if err := storage.ReadJSON(path, &payload); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		payload["state"] = state
		payload["message"] = strings.TrimSpace(message)
		payload["checked_at"] = checkedAt.UTC()
		payload["rate_limits"] = rateLimits
		return storage.WriteJSON(r.Paths, path, payload)
	})
}

// MarkVerificationPending marks a just-activated account as awaiting a live
// verification without throwing away its last known quota sample. Switching
// auth.json does not itself invalidate that account's quota, and preserving the
// sample avoids a blank dashboard while the background check is in flight.
func (r Repository) MarkVerificationPending(ctx context.Context, name string, now time.Time) error {
	path, err := r.Paths.Status(name)
	if err != nil {
		return err
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		payload := map[string]any{}
		if err := storage.ReadJSON(path, &payload); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		payload["state"] = StateStale
		payload["message"] = "activation pending live verification"
		payload["checked_at"] = now.UTC()
		return storage.WriteJSON(r.Paths, path, payload)
	})
}

// MarkVerificationPendingAfterCredentialChange clears the old quota sample.
// A completed device login can replace credentials for the same account, so
// the sample must not be shown as belonging to the new token.
func (r Repository) MarkVerificationPendingAfterCredentialChange(ctx context.Context, name string, now time.Time) error {
	return r.RecordCheckStatus(ctx, name, StateStale, "activation pending live verification", now, nil)
}

func (r Repository) List() ([]string, error) {
	if err := storage.EnsureDirs(r.Paths); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(r.Paths.AccountsDir())
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			names = append(names, entry.Name()[:len(entry.Name())-len(".json")])
		}
	}
	sort.Strings(names)
	return names, nil
}

func (r Repository) Active() (string, error) {
	var current state
	err := storage.ReadJSON(r.Paths.StateFile(), &current)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return current.Active, err
}

func (r Repository) Activate(ctx context.Context, name string) error {
	path, err := r.Paths.Account(name)
	if err != nil {
		return err
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("account %q: %w", name, err)
		}
		return storage.WriteJSON(r.Paths, r.Paths.StateFile(), state{Active: name})
	})
}

// SyncLive discovers the account currently loaded by Codex, tracks it when
// necessary, and reconciles every matching stored copy with the safest known
// credential. This preserves a token Codex refreshed itself while recovering
// from old duplicated account records made by earlier versions.
func (r Repository) SyncLive(ctx context.Context, livePath string) (LiveSyncResult, error) {
	live, err := readAuthFile(livePath)
	if errors.Is(err, os.ErrNotExist) {
		return LiveSyncResult{}, nil
	}
	if err != nil {
		return LiveSyncResult{}, fmt.Errorf("read live Codex auth: %w", err)
	}
	if !hasRefreshToken(live) {
		return LiveSyncResult{}, nil
	}
	var result LiveSyncResult
	err = storage.WithLock(ctx, r.Paths, func() error {
		names, err := r.listLocked()
		if err != nil {
			return err
		}
		matches := make([]string, 0, 1)
		for _, name := range names {
			stored, readErr := r.Read(name)
			if readErr != nil {
				continue
			}
			if same, _ := auth.SameIdentity(stored, live); same {
				matches = append(matches, name)
			}
		}
		name := ""
		if len(matches) > 0 {
			name = r.preferredMatchingNameLocked(matches)
			best := live
			bestWasLive := true
			for _, match := range matches {
				stored, readErr := r.Read(match)
				if readErr != nil {
					return readErr
				}
				if preferred, _ := auth.PreferCredential(stored, best, time.Now().UTC()); preferred {
					best = stored
					bestWasLive = false
				}
			}
			if !bestWasLive {
				if err := writeAuthFile(livePath, best); err != nil {
					return fmt.Errorf("restore fresher managed Codex auth: %w", err)
				}
			}
			for _, match := range matches {
				path, pathErr := r.Paths.Account(match)
				if pathErr != nil {
					return pathErr
				}
				if err := storage.WriteJSON(r.Paths, path, best); err != nil {
					return err
				}
			}
			result.Promoted = bestWasLive
		} else {
			name, err = r.nextLiveNameLocked(live, names)
			if err != nil {
				return err
			}
			path, pathErr := r.Paths.Account(name)
			if pathErr != nil {
				return pathErr
			}
			if err := storage.WriteJSON(r.Paths, path, live); err != nil {
				return err
			}
			result.Imported = true
		}
		if err := storage.WriteJSON(r.Paths, r.Paths.StateFile(), state{Active: name}); err != nil {
			return err
		}
		result.Name = name
		return nil
	})
	return result, err
}

func (r Repository) preferredMatchingNameLocked(matches []string) string {
	active, err := r.Active()
	if err == nil {
		for _, name := range matches {
			if name == active {
				return name
			}
		}
	}
	return matches[0]
}

// ActivateLive atomically replaces Codex's live auth.json with the selected
// managed account and marks that account active. The caller must ensure no
// active app-server turn can race this operation.
func (r Repository) ActivateLive(ctx context.Context, name, livePath string) error {
	path, err := r.Paths.Account(name)
	if err != nil {
		return err
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		credentials, err := readAuthFile(path)
		if err != nil {
			return fmt.Errorf("account %q: %w", name, err)
		}
		if !hasRefreshToken(credentials) {
			return ErrMissingRefresh
		}
		if err := writeAuthFile(livePath, credentials); err != nil {
			return fmt.Errorf("replace live Codex auth: %w", err)
		}
		return storage.WriteJSON(r.Paths, r.Paths.StateFile(), state{Active: name})
	})
}

func (r Repository) Rename(ctx context.Context, oldName, newName string) error {
	oldPath, err := r.Paths.Account(oldName)
	if err != nil {
		return err
	}
	newPath, err := r.Paths.Account(newName)
	if err != nil {
		return err
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		if _, err := os.Stat(newPath); err == nil {
			return ErrAccountExists
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.Rename(oldPath, newPath); err != nil {
			return err
		}
		oldStatus, statusErr := r.Paths.Status(oldName)
		if statusErr != nil {
			return statusErr
		}
		newStatus, statusErr := r.Paths.Status(newName)
		if statusErr != nil {
			return statusErr
		}
		if _, err := os.Stat(oldStatus); err == nil {
			if err := os.Rename(oldStatus, newStatus); err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if _, err := (history.Store{Paths: r.Paths}).RenameLocked(oldName, newName); err != nil {
			return err
		}
		active, err := r.Active()
		if err != nil || active != oldName {
			return err
		}
		return storage.WriteJSON(r.Paths, r.Paths.StateFile(), state{Active: newName})
	})
}

// Sync safely promotes a refreshed credential only when it belongs to the
// stored account. This prevents an OAuth response for another account from
// silently replacing the selected account.
func (r Repository) Sync(ctx context.Context, name string, refreshed map[string]any) error {
	if !hasRefreshToken(refreshed) {
		return ErrMissingRefresh
	}
	path, err := r.Paths.Account(name)
	if err != nil {
		return err
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		var existing map[string]any
		if err := storage.ReadJSON(path, &existing); err != nil {
			return err
		}
		if same, reason := auth.SameIdentity(existing, refreshed); !same {
			return fmt.Errorf("refusing account sync: %s", reason)
		}
		return storage.WriteJSON(r.Paths, path, refreshed)
	})
}

// Delete rejects protected accounts. inUse is supplied by the turn coordinator
// so a credential cannot disappear while a turn still depends on it.
func (r Repository) Delete(ctx context.Context, name string, pinned bool, inUse ...bool) error {
	if pinned {
		return ErrAccountPinned
	}
	if len(inUse) > 0 && inUse[0] {
		return ErrAccountInUse
	}
	path, err := r.Paths.Account(name)
	if err != nil {
		return err
	}
	return storage.WithLock(ctx, r.Paths, func() error {
		active, err := r.Active()
		if err != nil {
			return err
		}
		if active == name {
			return ErrAccountActive
		}
		return os.Remove(path)
	})
}

func hasRefreshToken(raw map[string]any) bool {
	tokens, _ := raw["tokens"].(map[string]any)
	refresh, _ := tokens["refresh_token"].(string)
	return refresh != ""
}

func (r Repository) listLocked() ([]string, error) {
	if err := storage.EnsureDirs(r.Paths); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(r.Paths.AccountsDir())
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			names = append(names, strings.TrimSuffix(entry.Name(), ".json"))
		}
	}
	sort.Strings(names)
	return names, nil
}

func (r Repository) nextLiveNameLocked(raw map[string]any, existing []string) (string, error) {
	base := strings.Split(auth.Metadata(raw)["email"], "@")[0]
	base = strings.Trim(base, " ._-")
	if base == "" {
		base = "active"
	}
	var normalized strings.Builder
	for _, character := range base {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || strings.ContainsRune("._-", character) {
			normalized.WriteRune(character)
		} else {
			normalized.WriteByte('-')
		}
	}
	base = strings.Trim(normalized.String(), "._-")
	if base == "" {
		base = "active"
	}
	known := make(map[string]struct{}, len(existing))
	for _, name := range existing {
		known[name] = struct{}{}
	}
	for index := 1; index < 10000; index++ {
		candidate := base
		if index > 1 {
			candidate = fmt.Sprintf("%s-%d", base, index)
		}
		if _, exists := known[candidate]; exists {
			continue
		}
		if _, err := storage.SanitizeAccountName(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("could not allocate a safe name for live Codex account")
}

func readAuthFile(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func writeAuthFile(path string, value map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".auth.json.*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
