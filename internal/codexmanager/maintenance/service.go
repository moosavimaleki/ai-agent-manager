package maintenance

import (
	"context"
	"errors"
	"fmt"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/auth"
	"abolqasem/internal/codexmanager/history"
	"abolqasem/internal/codexmanager/limits"
)

type Config struct {
	IncludeActive bool
	ForceRefresh  bool
	Accounts      []string
	ProxyURL      string
	Retention     time.Duration
	Now           func() time.Time
}

type Result struct {
	Account   string `json:"account"`
	State     string `json:"state"`
	Message   string `json:"message"`
	Refreshed bool   `json:"refreshed"`
}

type Summary struct {
	Results   []Result `json:"results"`
	Refreshed int      `json:"refreshed"`
	Failures  int      `json:"failures"`
}

type Service struct {
	Accounts account.Repository
	Limits   limits.Client
	History  history.Store
	Config   Config
}

func (s Service) Run(ctx context.Context) (Summary, error) {
	now := time.Now
	if s.Config.Now != nil {
		now = s.Config.Now
	}
	active, err := s.Accounts.Active()
	if err != nil {
		return Summary{}, err
	}
	names, err := s.Accounts.List()
	if err != nil {
		return Summary{}, err
	}
	summary := Summary{Results: make([]Result, 0, len(names))}
	requested := make(map[string]struct{}, len(s.Config.Accounts))
	for _, name := range s.Config.Accounts {
		requested[name] = struct{}{}
	}
	for _, name := range names {
		if len(requested) > 0 {
			if _, ok := requested[name]; !ok {
				continue
			}
		}
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		if name == active && !s.Config.IncludeActive {
			summary.Results = append(summary.Results, Result{Account: name, State: "ok", Message: "active; skipped refresh"})
			continue
		}
		result := s.checkOne(ctx, name, active, now())
		summary.Results = append(summary.Results, result)
		if result.Refreshed {
			summary.Refreshed++
		}
		if result.State != "ok" {
			summary.Failures++
		}
	}
	if s.Config.Retention > 0 {
		_, _ = s.History.Prune(ctx, s.Config.Retention, now())
	}
	return summary, nil
}

func (s Service) checkOne(ctx context.Context, name, active string, now time.Time) (result Result) {
	result = Result{Account: name, State: "ok"}
	var snapshot *limits.Snapshot
	defer func() {
		// Persist failures too. Previously an auth failure returned before the
		// status write, leaving an old "ready" sample visible and selectable.
		// The request context may already be cancelled by a failed network
		// check, but recording that failure is precisely the important part.
		persistCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		// A successful quota fetch is the user-facing proof that the account is
		// usable. Reasons such as "access token is still valid" are internal
		// refresh diagnostics, not an account status, and used to leak into the
		// dashboard as a misleading warning.
		statusMessage := result.Message
		if result.State == "ok" && !result.Refreshed {
			statusMessage = ""
		}
		if err := s.Accounts.RecordCheckStatus(persistCtx, name, persistedState(result.State), statusMessage, now, snapshot); err != nil && result.State == "ok" {
			result = failed(result, "error", fmt.Errorf("persist verification result: %w", err))
		}
	}()
	credentials, err := s.Accounts.Read(name)
	if err != nil {
		return failed(result, "needs_login", err)
	}
	limitsClient := s.Limits
	limitsClient.ProxyURL = s.Config.ProxyURL
	needed, reason := auth.ShouldRefresh(credentials, now)
	if s.Config.ForceRefresh {
		needed = true
		reason = "force refresh requested"
	}
	if needed {
		client, clientErr := auth.NewHTTPClient(s.Config.ProxyURL, 30*time.Second)
		if clientErr != nil {
			return failed(result, "error", clientErr)
		}
		refreshed, refreshErr := (auth.Refresher{Client: client, Now: func() time.Time { return now }}).Refresh(ctx, credentials)
		if refreshErr != nil {
			return failed(result, "needs_login", refreshErr)
		}
		if syncErr := s.Accounts.Sync(ctx, name, refreshed); syncErr != nil {
			return failed(result, "error", syncErr)
		}
		credentials = refreshed
		result.Refreshed = true
		result.Message = "refreshed: " + reason
	} else {
		result.Message = reason
	}
	fetched, fetchErr := limitsClient.Fetch(ctx, name, credentials)
	if fetchErr != nil {
		return failed(result, errorState(fetchErr), fetchErr)
	}
	snapshot = &fetched
	_, _ = s.History.Append(ctx, fetched)
	if name == active {
		// The live auth file is owned by app-server. Maintenance intentionally
		// never overwrites it while a turn is running.
		result.Message += "; active credentials unchanged"
	}
	return result
}

func persistedState(resultState string) account.State {
	switch resultState {
	case "ok":
		return account.StateReady
	case "needs_login":
		return account.StateNeedsLogin
	case "warning":
		return account.StateStale
	default:
		return account.StateError
	}
}

func failed(result Result, state string, err error) Result {
	result.State = state
	result.Message = safeError(err)
	return result
}

func errorState(err error) string {
	var fetchErr *limits.FetchError
	if errors.As(err, &fetchErr) && fetchErr.Kind == limits.ErrorAuth {
		return "needs_login"
	}
	return "warning"
}

func safeError(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%v", err)
}
