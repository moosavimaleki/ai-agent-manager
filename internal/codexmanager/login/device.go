package login

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/auth"
)

var (
	ErrLoginTimeout       = errors.New("device login timed out")
	ErrLoginCancelled     = errors.New("device login cancelled")
	ErrLoginEmailMismatch = errors.New("device login email does not match account")
)

type Code struct {
	LoginID         string `json:"loginId"`
	VerificationURL string `json:"verificationUrl"`
	UserCode        string `json:"userCode"`
}

type Result struct {
	Name      string `json:"name"`
	Email     string `json:"email,omitempty"`
	AccountID string `json:"accountId,omitempty"`
	Replaced  bool   `json:"replaced"`
}

type Client interface {
	StartDeviceLogin(context.Context) (Code, error)
	WaitDeviceLogin(context.Context, string) (map[string]any, error)
	CancelDeviceLogin(context.Context, string) error
}

type Callbacks struct {
	OnCode func(Code)
	OnPoll func(attempt int, remaining time.Duration)
}

type Service struct {
	Accounts account.Repository
	Client   Client
	Timeout  time.Duration
	Now      func() time.Time
}

func (s Service) Login(ctx context.Context, name string, replace bool, expectedEmail string, callbacks Callbacks) (Result, error) {
	if s.Client == nil {
		return Result{}, errors.New("device login client is not configured")
	}
	if _, err := s.Accounts.Paths.Account(name); err != nil {
		return Result{}, err
	}
	if !replace {
		if _, err := s.Accounts.Read(name); err == nil {
			return Result{}, fmt.Errorf("account %q already exists", name)
		}
	} else if _, err := s.Accounts.Read(name); err != nil {
		return Result{}, fmt.Errorf("cannot relogin unknown account %q", name)
	}
	code, err := s.Client.StartDeviceLogin(ctx)
	if err != nil {
		return Result{}, err
	}
	if code.LoginID == "" || code.VerificationURL == "" || code.UserCode == "" {
		return Result{}, errors.New("device login response missing code fields")
	}
	if callbacks.OnCode != nil {
		callbacks.OnCode(code)
	}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Minute
	}
	loginCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	authData, err := s.Client.WaitDeviceLogin(loginCtx, code.LoginID)
	if err != nil {
		if errors.Is(loginCtx.Err(), context.DeadlineExceeded) {
			_ = s.Client.CancelDeviceLogin(context.Background(), code.LoginID)
			return Result{}, ErrLoginTimeout
		}
		if errors.Is(loginCtx.Err(), context.Canceled) {
			_ = s.Client.CancelDeviceLogin(context.Background(), code.LoginID)
			return Result{}, ErrLoginCancelled
		}
		return Result{}, err
	}
	if !hasTokens(authData) {
		return Result{}, errors.New("device login completed without tokens")
	}
	metadata := auth.Metadata(authData)
	if replace {
		stored, readErr := s.Accounts.Read(name)
		if readErr != nil {
			return Result{}, readErr
		}
		storedEmail := normalizeEmail(auth.Metadata(stored)["email"])
		expected := normalizeEmail(expectedEmail)
		if expected == "" {
			expected = storedEmail
		}
		if expected == "" || normalizeEmail(metadata["email"]) != expected {
			return Result{}, ErrLoginEmailMismatch
		}
	}
	if err := s.Accounts.Add(ctx, name, authData, replace); err != nil {
		return Result{}, err
	}
	// The credentials just changed. Any previous quota snapshot belongs to the
	// old token and must never be shown as valid while the dashboard refreshes.
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	if err := s.Accounts.MarkVerificationPendingAfterCredentialChange(ctx, name, now().UTC()); err != nil {
		return Result{}, err
	}
	return Result{Name: name, Email: metadata["email"], AccountID: metadata["account_id"], Replaced: replace}, nil
}

func hasTokens(raw map[string]any) bool {
	tokens, _ := raw["tokens"].(map[string]any)
	refresh, _ := tokens["refresh_token"].(string)
	access, _ := tokens["access_token"].(string)
	return strings.TrimSpace(refresh) != "" && strings.TrimSpace(access) != ""
}

func normalizeEmail(value string) string { return strings.ToLower(strings.TrimSpace(value)) }
