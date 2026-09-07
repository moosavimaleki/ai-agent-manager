package login

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/auth"
	"abolqasem/internal/codexmanager/storage"
)

type fakeClient struct {
	code      Code
	data      map[string]any
	waitError error
	cancelled bool
}

func TestAppServerClientImportsTemporaryDeviceLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	bin := filepath.Join(root, "codex")
	script := `#!/bin/sh
read ignored
printf '%s\n' '{"id":"1","result":{}}'
read ignored
mkdir -p "$CODEX_HOME"
printf '%s' '{"email":"user@example.com","tokens":{"access_token":"access","refresh_token":"refresh"}}' > "$CODEX_HOME/auth.json"
printf '%s\n' '{"id":"2","result":{"type":"chatgptDeviceCode","loginId":"login-1","verificationUrl":"https://chatgpt.com/device","userCode":"ABCD"}}'
printf '%s\n' '{"method":"account/login/completed","params":{"loginId":"login-1","success":true,"error":null}}'
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	client := &AppServerClient{Executable: bin, TempRoot: root}
	code, err := client.StartDeviceLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if code.UserCode != "ABCD" || code.LoginID != "login-1" {
		t.Fatalf("unexpected device code: %#v", code)
	}
	authData, err := client.WaitDeviceLogin(context.Background(), code.LoginID)
	if err != nil {
		t.Fatal(err)
	}
	if !hasTokens(authData) || auth.Metadata(authData)["email"] != "user@example.com" {
		t.Fatalf("unexpected imported auth: %#v", authData)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() && len(entry.Name()) > len("codex-manager-login-") && entry.Name()[:len("codex-manager-login-")] == "codex-manager-login-" {
			t.Fatalf("temporary login home was not removed: %s", entry.Name())
		}
	}
}

func TestAppServerClientCleansInterruptedTemporaryLoginHomes(t *testing.T) {
	root := t.TempDir()
	stale := filepath.Join(root, "codex-manager-login-interrupted")
	if err := os.Mkdir(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "auth.json"), []byte("temporary"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &AppServerClient{TempRoot: root}
	if err := client.CleanupStaleTempHomes(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale device-login home was not removed: %v", err)
	}
}

func (f *fakeClient) StartDeviceLogin(context.Context) (Code, error) { return f.code, nil }
func (f *fakeClient) WaitDeviceLogin(ctx context.Context, _ string) (map[string]any, error) {
	if f.waitError != nil {
		<-ctx.Done()
		return nil, f.waitError
	}
	return f.data, nil
}
func (f *fakeClient) CancelDeviceLogin(context.Context, string) error { f.cancelled = true; return nil }

func loginAuth(email string) map[string]any {
	return map[string]any{"email": email, "tokens": map[string]any{"refresh_token": "refresh", "access_token": "access"}}
}

func TestDeviceLoginImportsAndCallsCodeCallback(t *testing.T) {
	client := &fakeClient{code: Code{LoginID: "login-1", VerificationURL: "https://example.invalid", UserCode: "ABCD"}, data: loginAuth("user@example.com")}
	repository := account.Repository{Paths: storage.Paths{Home: t.TempDir()}}
	service := Service{Accounts: repository, Client: client, Now: func() time.Time { return time.Date(2026, 9, 5, 10, 0, 0, 0, time.UTC) }}
	called := false
	result, err := service.Login(context.Background(), "user", false, "", Callbacks{OnCode: func(Code) { called = true }})
	if err != nil || !called || result.Email != "user@example.com" {
		t.Fatalf("result=%#v err=%v called=%v", result, err, called)
	}
	status, err := repository.Status("user")
	if err != nil || status.State != account.StateStale || status.RateLimits != nil || status.Message != "activation pending live verification" {
		t.Fatalf("new credentials must invalidate old quota status: status=%#v err=%v", status, err)
	}
}

func TestDeviceLoginTimeoutCancels(t *testing.T) {
	client := &fakeClient{code: Code{LoginID: "login-1", VerificationURL: "https://example.invalid", UserCode: "ABCD"}, waitError: errors.New("poll stopped")}
	service := Service{Accounts: account.Repository{Paths: storage.Paths{Home: t.TempDir()}}, Client: client, Timeout: time.Millisecond}
	_, err := service.Login(context.Background(), "user", false, "", Callbacks{})
	if !errors.Is(err, ErrLoginTimeout) || !client.cancelled {
		t.Fatalf("err=%v cancelled=%v", err, client.cancelled)
	}
}

func TestDeviceLoginRejectsReplacementEmailMismatch(t *testing.T) {
	home := t.TempDir()
	repo := account.Repository{Paths: storage.Paths{Home: home}}
	if err := repo.Add(context.Background(), "user", loginAuth("old@example.com"), false); err != nil {
		t.Fatal(err)
	}
	client := &fakeClient{code: Code{LoginID: "login-1", VerificationURL: "https://example.invalid", UserCode: "ABCD"}, data: loginAuth("new@example.com")}
	service := Service{Accounts: repo, Client: client}
	_, err := service.Login(context.Background(), "user", true, "old@example.com", Callbacks{})
	if !errors.Is(err, ErrLoginEmailMismatch) {
		t.Fatalf("err=%v", err)
	}
}
