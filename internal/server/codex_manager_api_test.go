package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/browser"
	"abolqasem/internal/codexmanager/history"
	"abolqasem/internal/codexmanager/limits"
	"abolqasem/internal/codexmanager/storage"
)

func TestCodexManagerOfficialSignInURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "official auth host", raw: "https://auth.openai.com/codex/device", want: "https://auth.openai.com/codex/device"},
		{name: "official ChatGPT host", raw: "https://chatgpt.com/auth/login", want: "https://chatgpt.com/auth/login"},
		{name: "reject non HTTPS", raw: "http://auth.openai.com/codex/device"},
		{name: "reject untrusted host", raw: "https://auth.openai.com.evil.example/codex/device"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := codexManagerOfficialSignInURL(test.raw)
			if test.want == "" {
				if err == nil {
					t.Fatalf("expected URL %q to be rejected", test.raw)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("got=%q err=%v want=%q", got, err, test.want)
			}
		})
	}
}

func TestCodexManagerChromeLoginOpensAssociatedProfileOnly(t *testing.T) {
	previousDir := codexManagerStateDir
	previousFind := codexManagerFindChromeProfile
	previousOpen := codexManagerOpenChromeProfileAt
	stateDir := t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerFindChromeProfile = func(id string) (browser.Profile, bool) {
		if id != "google-chrome/Profile 4" {
			return browser.Profile{}, false
		}
		return browser.Profile{ID: id, Name: "Managed", Directory: "Profile 4"}, true
	}
	var openedProfile browser.Profile
	var openedURL string
	codexManagerOpenChromeProfileAt = func(profile browser.Profile, target string) error {
		openedProfile, openedURL = profile, target
		return nil
	}
	t.Cleanup(func() {
		codexManagerStateDir = previousDir
		codexManagerFindChromeProfile = previousFind
		codexManagerOpenChromeProfileAt = previousOpen
	})

	repository := account.Repository{Paths: codexManagerPaths()}
	if err := repository.Add(context.Background(), "personal", map[string]any{"tokens": map[string]any{"refresh_token": "refresh"}}, false); err != nil {
		t.Fatal(err)
	}
	statusPath, err := repository.Paths.Status("personal")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.WriteJSON(repository.Paths, statusPath, map[string]any{
		"state":          "needs_login",
		"chrome_profile": account.ChromeProfile{ID: "google-chrome/Profile 4", Name: "Managed"},
	}); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/codex-manager/accounts/personal/chrome-login", bytes.NewBufferString(`{"verificationUrl":"https://auth.openai.com/codex/device"}`))
	handleAPICodexManagerAccountAction(recorder, request, "personal/chrome-login")
	if recorder.Code != http.StatusOK || openedProfile.ID != "google-chrome/Profile 4" || openedURL != "https://auth.openai.com/codex/device" {
		t.Fatalf("code=%d profile=%#v url=%q body=%s", recorder.Code, openedProfile, openedURL, recorder.Body.String())
	}
}

func TestCodexManagerAccountAPIRedactsCredentialsAndSupportsCRUD(t *testing.T) {
	previousDir, previousLiveRoot, previousCheck := codexManagerStateDir, codexManagerLiveAuthRoot, startCodexManagerPostSwitchCheck
	stateDir := t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = t.TempDir
	// Creating an active account schedules a background quota check. Suppress it
	// here so it cannot write into this test's TempDir after cleanup begins.
	startCodexManagerPostSwitchCheck = func(string) {}
	t.Cleanup(func() {
		codexManagerStateDir, codexManagerLiveAuthRoot, startCodexManagerPostSwitchCheck = previousDir, previousLiveRoot, previousCheck
	})

	create := httptest.NewRequest(http.MethodPost, "/api/codex-manager/accounts", bytes.NewBufferString(`{"name":"personal","credentials":{"email":"user@example.com","tokens":{"access_token":"access-secret","refresh_token":"refresh-secret"}},"activate":true}`))
	created := httptest.NewRecorder()
	handleAPICodexManagerAccounts(created, create)
	if created.Code != http.StatusOK || bytes.Contains(created.Body.Bytes(), []byte("access-secret")) || bytes.Contains(created.Body.Bytes(), []byte("refresh-secret")) {
		t.Fatalf("unsafe create response: code=%d body=%s", created.Code, created.Body.String())
	}

	renamed := httptest.NewRecorder()
	handleAPICodexManagerAccountAction(renamed, httptest.NewRequest(http.MethodPost, "/api/codex-manager/accounts/personal/rename", bytes.NewBufferString(`{"name":"work"}`)), "personal/rename")
	if renamed.Code != http.StatusOK {
		t.Fatalf("rename response: %d %s", renamed.Code, renamed.Body.String())
	}

	listed := httptest.NewRecorder()
	handleAPICodexManagerAccounts(listed, httptest.NewRequest(http.MethodGet, "/api/codex-manager/accounts", nil))
	var response struct {
		Accounts []struct {
			Name   string `json:"name"`
			Active bool   `json:"active"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &response); err != nil || len(response.Accounts) != 1 || response.Accounts[0].Name != "work" || !response.Accounts[0].Active {
		t.Fatalf("unexpected list response: %s err=%v", listed.Body.String(), err)
	}
}

func TestCodexManagerAccountListIncludesSafeStoredStatus(t *testing.T) {
	previousDir, previousLiveRoot := codexManagerStateDir, codexManagerLiveAuthRoot
	stateDir := t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = t.TempDir
	t.Cleanup(func() { codexManagerStateDir, codexManagerLiveAuthRoot = previousDir, previousLiveRoot })
	paths := codexManagerPaths()
	repository := account.Repository{Paths: paths}
	if err := repository.Add(context.Background(), "personal", map[string]any{"tokens": map[string]any{"refresh_token": "refresh"}}, false); err != nil {
		t.Fatal(err)
	}
	statusPath, err := paths.Status("personal")
	if err != nil {
		t.Fatal(err)
	}
	checkedAt := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	resetAt := checkedAt.Add(5 * time.Hour)
	resetAfter := 5 * 60 * 60
	snapshot := limits.Snapshot{
		Account:     "personal",
		FetchedAt:   checkedAt,
		ReachedType: "weekly",
		Error:       "safe status error",
		Limits: []limits.Limit{{
			ID:           "codex",
			Name:         "Codex quota",
			LimitReached: true,
			Credits:      &limits.Credits{HasCredits: true, Balance: "12"},
			Windows: []limits.Window{
				{Label: "5h", RemainingPercent: 63, ResetAfterSeconds: &resetAfter, ResetAt: &resetAt},
				{Label: "weekly", RemainingPercent: 45, Reached: true},
			},
		}},
	}
	if err := storage.WriteJSON(paths, statusPath, map[string]any{"state": "needs_login", "message": "saved status", "checked_at": checkedAt, "rate_limits": snapshot}); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handleAPICodexManagerAccounts(recorder, httptest.NewRequest(http.MethodGet, "/api/codex-manager/accounts", nil))
	var response struct {
		Accounts []account.Account `json:"accounts"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Accounts) != 1 || response.Accounts[0].State != account.StateNeedsLogin || response.Accounts[0].LastCheckedAt == nil || !response.Accounts[0].LastCheckedAt.Equal(checkedAt) || response.Accounts[0].StatusMessage != "saved status" || response.Accounts[0].RateLimits == nil || len(response.Accounts[0].RateLimits.Limits) != 1 || len(response.Accounts[0].RateLimits.Limits[0].Windows) != 2 || response.Accounts[0].RateLimits.ReachedType != "weekly" || response.Accounts[0].RateLimits.Error != "safe status error" || response.Accounts[0].RateLimits.Limits[0].Credits == nil || response.Accounts[0].RateLimits.Limits[0].Credits.Balance != "12" {
		t.Fatalf("unexpected account status: %#v", response.Accounts)
	}
}

func TestChromeScanKeepsLastProfileAssociationAndMarksChangedSignIn(t *testing.T) {
	previousDir, previousLiveRoot := codexManagerStateDir, codexManagerLiveAuthRoot
	stateDir := t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = t.TempDir
	t.Cleanup(func() { codexManagerStateDir, codexManagerLiveAuthRoot = previousDir, previousLiveRoot })

	paths := codexManagerPaths()
	repository := account.Repository{Paths: paths}
	if err := repository.Add(context.Background(), "personal", map[string]any{"email": "person@example.com", "tokens": map[string]any{"refresh_token": "refresh-token"}}, false); err != nil {
		t.Fatal(err)
	}
	first := codexManagerChromeScanSnapshot{
		ScannedAt: time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC),
		Profiles: []map[string]any{{
			"id": "google-chrome/Default", "name": "Default", "outcome": "signed_in", "managedAccount": "personal", "activeEmail": "person@example.com",
		}},
	}
	if err := codexManagerStoreChromeProfileAssociations(first); err != nil {
		t.Fatal(err)
	}
	changed := first
	changed.ScannedAt = changed.ScannedAt.Add(15 * time.Minute)
	changed.Profiles = []map[string]any{{
		"id": "google-chrome/Default", "name": "Default", "outcome": "signed_in", "activeEmail": "someone-else@example.com",
	}}
	if err := codexManagerStoreChromeProfileAssociations(changed); err != nil {
		t.Fatal(err)
	}
	accounts := redactCodexManagerAccounts(repository)
	if len(accounts) != 1 || accounts[0].ChromeProfile == nil {
		t.Fatalf("missing stored Chrome association: %#v", accounts)
	}
	profile := accounts[0].ChromeProfile
	if profile.ID != "google-chrome/Default" || profile.Name != "Default" || profile.Outcome != "changed" || profile.ActiveEmail != "someone-else@example.com" || profile.LastSeenAt == nil || !profile.LastSeenAt.Equal(first.ScannedAt) {
		t.Fatalf("unexpected Chrome association: %#v", profile)
	}
}

func TestChromeScanAssociatesSavedAccountWhenChatGPTIsSignedOut(t *testing.T) {
	previousDir, previousLiveRoot := codexManagerStateDir, codexManagerLiveAuthRoot
	stateDir := t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = t.TempDir
	t.Cleanup(func() { codexManagerStateDir, codexManagerLiveAuthRoot = previousDir, previousLiveRoot })

	paths := codexManagerPaths()
	repository := account.Repository{Paths: paths}
	if err := repository.Add(context.Background(), "work", map[string]any{"email": "work@example.com", "tokens": map[string]any{"refresh_token": "refresh-token"}}, false); err != nil {
		t.Fatal(err)
	}
	snapshot := codexManagerChromeScanSnapshot{
		ScannedAt: time.Date(2026, 9, 5, 8, 0, 0, 0, time.UTC),
		Profiles: []map[string]any{{
			"id": "google-chrome/Profile 3", "name": "Work", "outcome": "signed_out",
			"accounts":        map[string]string{"work@example.com": "work"},
			"lastActiveEmail": "work@example.com", "lastManagedAccount": "work",
		}},
	}
	if err := codexManagerStoreChromeProfileAssociations(snapshot); err != nil {
		t.Fatal(err)
	}
	accounts := redactCodexManagerAccounts(repository)
	if len(accounts) != 1 || accounts[0].ChromeProfile == nil {
		t.Fatalf("missing Chrome association: %#v", accounts)
	}
	profile := accounts[0].ChromeProfile
	if profile.Name != "Work" || profile.Outcome != "signed_out" || profile.LastActiveEmail != "work@example.com" || profile.LastManagedAccount != "work" || profile.LastSeenAt == nil || !profile.LastSeenAt.Equal(snapshot.ScannedAt) {
		t.Fatalf("unexpected Chrome association: %#v", profile)
	}
}

func TestChromeScanRetainsUnavailableProfileInChromeTable(t *testing.T) {
	profiles := codexManagerAppendMissingChromeProfiles(nil, []account.Account{{
		Name:  "archived",
		Email: "archived@example.com",
		ChromeProfile: &account.ChromeProfile{
			ID:                 "google-chrome/Profile 9",
			Name:               "Archived work",
			LastActiveEmail:    "archived@example.com",
			LastManagedAccount: "archived",
		},
	}})
	if len(profiles) != 1 {
		t.Fatalf("profiles=%#v", profiles)
	}
	profile := profiles[0]
	if profile["outcome"] != "missing" || profile["lastActiveEmail"] != "archived@example.com" || profile["lastManagedAccount"] != "archived" {
		t.Fatalf("unexpected missing profile: %#v", profile)
	}
	linked, _ := profile["accounts"].(map[string]string)
	if linked["archived@example.com"] != "archived" {
		t.Fatalf("linked accounts=%#v", linked)
	}
}

func TestCodexManagerCheckAPICompletesWithoutAccounts(t *testing.T) {
	previousDir, previousLiveRoot := codexManagerStateDir, codexManagerLiveAuthRoot
	stateDir := t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = t.TempDir
	t.Cleanup(func() { codexManagerStateDir, codexManagerLiveAuthRoot = previousDir, previousLiveRoot })
	recorder := httptest.NewRecorder()
	handleAPICodexManager(recorder, httptest.NewRequest(http.MethodPost, "/api/codex-manager/check", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("check response: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestCodexManagerHistoryAPIBoundsPagesAndBuildsLocalizedSeries(t *testing.T) {
	previousDir := codexManagerStateDir
	stateDir := t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	t.Cleanup(func() { codexManagerStateDir = previousDir })
	store := history.Store{Paths: codexManagerPaths()}
	start := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Hour)
	for index := 0; index < 4; index++ {
		snapshot := limits.Snapshot{Account: "personal", FetchedAt: start.Add(time.Duration(index) * time.Hour), Limits: []limits.Limit{{ID: "codex", Windows: []limits.Window{{Label: "weekly", RemainingPercent: float64(90 - index)}}}}}
		if _, err := store.Append(context.Background(), snapshot); err != nil {
			t.Fatal(err)
		}
	}
	page := httptest.NewRecorder()
	handleAPICodexManagerHistory(page, httptest.NewRequest(http.MethodGet, "/api/codex-manager/history?account=personal&limit=2", nil))
	var paged struct {
		Items      []history.Sample `json:"items"`
		NextBefore string           `json:"nextBefore"`
	}
	if page.Code != http.StatusOK || json.Unmarshal(page.Body.Bytes(), &paged) != nil || len(paged.Items) != 2 || paged.NextBefore == "" {
		t.Fatalf("page response: %d %s", page.Code, page.Body.String())
	}
	series := httptest.NewRecorder()
	handleAPICodexManagerHistory(series, httptest.NewRequest(http.MethodGet, "/api/codex-manager/history?account=personal&window=weekly&range=7d&timezone=%2B03%3A30&limit=2", nil))
	var response struct {
		Series history.Series `json:"series"`
	}
	if series.Code != http.StatusOK || json.Unmarshal(series.Body.Bytes(), &response) != nil || response.Series.Timezone != "UTC+03:30" || len(response.Series.Points) != 2 {
		t.Fatalf("series response: %d %s", series.Code, series.Body.String())
	}
}

func TestCodexManagerAccountsDiscoversCurrentLiveAuthAsActive(t *testing.T) {
	previousDir, previousLiveRoot := codexManagerStateDir, codexManagerLiveAuthRoot
	stateDir, codexRoot := t.TempDir(), t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = func() string { return codexRoot }
	t.Cleanup(func() { codexManagerStateDir, codexManagerLiveAuthRoot = previousDir, previousLiveRoot })
	if err := os.WriteFile(filepath.Join(codexRoot, "auth.json"), []byte(`{"email":"current@example.com","tokens":{"refresh_token":"live-refresh"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handleAPICodexManagerAccounts(recorder, httptest.NewRequest(http.MethodGet, "/api/codex-manager/accounts", nil))
	var response struct {
		Accounts []account.Account `json:"accounts"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || len(response.Accounts) != 1 || response.Accounts[0].Name != "current" || !response.Accounts[0].Active || response.Accounts[0].Email != "current@example.com" {
		t.Fatalf("live account response: code=%d accounts=%#v", recorder.Code, response.Accounts)
	}
}

func TestCodexManagerAccountsReconcilesDuplicateIdentityRecords(t *testing.T) {
	previousDir, previousLiveRoot := codexManagerStateDir, codexManagerLiveAuthRoot
	stateDir, codexRoot := t.TempDir(), t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = func() string { return codexRoot }
	t.Cleanup(func() { codexManagerStateDir, codexManagerLiveAuthRoot = previousDir, previousLiveRoot })

	repository := account.Repository{Paths: codexManagerPaths()}
	credentials := map[string]any{
		"email":  "duplicate@example.com",
		"tokens": map[string]any{"refresh_token": "duplicate-refresh"},
	}
	if err := repository.Add(context.Background(), "first", credentials, false); err != nil {
		t.Fatal(err)
	}
	secondPath, err := repository.Paths.Account("second")
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.WriteJSON(repository.Paths, secondPath, credentials); err != nil {
		t.Fatal(err)
	}
	live, err := json.Marshal(credentials)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexRoot, "auth.json"), live, 0o600); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	handleAPICodexManagerAccounts(recorder, httptest.NewRequest(http.MethodGet, "/api/codex-manager/accounts", nil))
	var response struct {
		Accounts []account.Account `json:"accounts"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || len(response.Accounts) != 2 || !response.Accounts[0].Active {
		t.Fatalf("duplicate identity response: code=%d response=%#v", recorder.Code, response)
	}
}

func TestCodexManagerAccountActivationReplacesLiveAuth(t *testing.T) {
	previousDir, previousLiveRoot, previousCheck := codexManagerStateDir, codexManagerLiveAuthRoot, startCodexManagerPostSwitchCheck
	stateDir, codexRoot := t.TempDir(), t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = func() string { return codexRoot }
	// Activation schedules a background quota check. Keep this unit test
	// deterministic and prevent that goroutine from writing into TempDir after
	// the test has returned and cleanup has started.
	startCodexManagerPostSwitchCheck = func(string) {}
	t.Cleanup(func() {
		codexManagerStateDir, codexManagerLiveAuthRoot, startCodexManagerPostSwitchCheck = previousDir, previousLiveRoot, previousCheck
	})
	repository := account.Repository{Paths: codexManagerPaths()}
	if err := repository.Add(context.Background(), "chosen", map[string]any{"email": "chosen@example.com", "tokens": map[string]any{"refresh_token": "chosen-refresh"}}, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexRoot, "auth.json"), []byte(`{"email":"old@example.com","tokens":{"refresh_token":"old-refresh"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handleAPICodexManagerAccountAction(recorder, httptest.NewRequest(http.MethodPost, "/api/codex-manager/accounts/chosen/activate", nil), "chosen/activate")
	if recorder.Code != http.StatusOK {
		t.Fatalf("activation response: %d %s", recorder.Code, recorder.Body.String())
	}
	live, err := os.ReadFile(filepath.Join(codexRoot, "auth.json"))
	if err != nil || !bytes.Contains(live, []byte("chosen-refresh")) || bytes.Contains(live, []byte("old-refresh")) {
		t.Fatalf("live auth was not atomically replaced: %q, %v", live, err)
	}
	if active, err := repository.Active(); err != nil || active != "chosen" {
		t.Fatalf("active account = %q, %v", active, err)
	}
}

func TestSwitchCodexManagerLiveAccountReportsWhetherAuthChanged(t *testing.T) {
	previousDir, previousLiveRoot, previousCheck := codexManagerStateDir, codexManagerLiveAuthRoot, startCodexManagerPostSwitchCheck
	stateDir, codexRoot := t.TempDir(), t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = func() string { return codexRoot }
	startCodexManagerPostSwitchCheck = func(string) {}
	t.Cleanup(func() {
		codexManagerStateDir, codexManagerLiveAuthRoot, startCodexManagerPostSwitchCheck = previousDir, previousLiveRoot, previousCheck
	})

	repository := account.Repository{Paths: codexManagerPaths()}
	if err := repository.Add(context.Background(), "chosen", map[string]any{
		"email":  "chosen@example.com",
		"tokens": map[string]any{"refresh_token": "chosen-refresh"},
	}, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexRoot, "auth.json"), []byte(`{"email":"old@example.com","tokens":{"refresh_token":"old-refresh"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	changed, err := switchCodexManagerLiveAccountWithResult(context.Background(), repository, "chosen")
	if err != nil || !changed {
		t.Fatalf("first switch = changed:%t err:%v, want changed auth", changed, err)
	}
	changed, err = switchCodexManagerLiveAccountWithResult(context.Background(), repository, "chosen")
	if err != nil || changed {
		t.Fatalf("same-account switch = changed:%t err:%v, want unchanged auth", changed, err)
	}
}

func TestCodexManagerAccountActivationKeepsRunningTurnAndReplacesLiveAuth(t *testing.T) {
	previousDir, previousLiveRoot, previousSessions, previousCheck := codexManagerStateDir, codexManagerLiveAuthRoot, workspaceCodexSessions, startCodexManagerPostSwitchCheck
	stateDir, codexRoot := t.TempDir(), t.TempDir()
	codexManagerStateDir = func() string { return stateDir }
	codexManagerLiveAuthRoot = func() string { return codexRoot }
	busy := &workspaceCodexSession{}
	busy.turnMu.Lock()
	workspaceCodexSessions = &workspaceCodexSessionManager{sessions: map[string]*workspaceCodexSession{"chat": busy}}
	startCodexManagerPostSwitchCheck = func(string) {}
	t.Cleanup(func() {
		busy.turnMu.Unlock()
		codexManagerStateDir, codexManagerLiveAuthRoot, workspaceCodexSessions, startCodexManagerPostSwitchCheck = previousDir, previousLiveRoot, previousSessions, previousCheck
	})
	repository := account.Repository{Paths: codexManagerPaths()}
	if err := repository.Add(context.Background(), "chosen", map[string]any{"email": "chosen@example.com", "tokens": map[string]any{"refresh_token": "chosen-refresh"}}, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexRoot, "auth.json"), []byte(`{"email":"old@example.com","tokens":{"refresh_token":"old-refresh"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := switchCodexManagerLiveAccount(context.Background(), repository, "chosen"); err != nil {
		t.Fatalf("activation while a turn runs: %v", err)
	}
	live, err := os.ReadFile(filepath.Join(codexRoot, "auth.json"))
	if err != nil || !bytes.Contains(live, []byte("chosen-refresh")) || bytes.Contains(live, []byte("old-refresh")) {
		t.Fatalf("live auth was not changed for future sessions: %q, %v", live, err)
	}
	if workspaceCodexSessions.sessions["chat"] != busy {
		t.Fatal("running session was interrupted by account switch")
	}
}
