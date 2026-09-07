package account

import (
	"time"

	"abolqasem/internal/codexmanager/limits"
)

type Plan string

const (
	PlanFree    Plan = "free"
	PlanPlus    Plan = "plus"
	PlanUnknown Plan = "unknown"
)

type State string

const (
	StateReady      State = "ready"
	StateNeedsLogin State = "needs_login"
	StateError      State = "error"
	StateStale      State = "stale"
)

type Account struct {
	Name           string           `json:"name"`
	Email          string           `json:"email,omitempty"`
	AccountID      string           `json:"accountId,omitempty"`
	Plan           Plan             `json:"plan"`
	State          State            `json:"state"`
	TokenExpiresAt *time.Time       `json:"tokenExpiresAt,omitempty"`
	Active         bool             `json:"active"`
	Pinned         bool             `json:"pinned"`
	LastCheckedAt  *time.Time       `json:"lastCheckedAt,omitempty"`
	LastRefreshAt  *time.Time       `json:"lastRefreshAt,omitempty"`
	StatusMessage  string           `json:"statusMessage,omitempty"`
	RateLimits     *limits.Snapshot `json:"rateLimits,omitempty"`
	SessionMonitor *SessionMonitor  `json:"sessionMonitor,omitempty"`
	ChromeProfile  *ChromeProfile   `json:"chromeProfile,omitempty"`
}

// Status is the persisted, token-free result of the most recent live account
// verification. It is deliberately separate from Account so the same exact
// projection can drive both the HTTP dashboard and automatic selection.
// Missing or unreadable status is stale, never implicitly ready.
type Status struct {
	State                  State
	Message                string
	CheckedAt              *time.Time
	RateLimits             *limits.Snapshot
	SessionMonitor         *SessionMonitor
	SessionMonitorDisabled bool
	ChromeProfile          *ChromeProfile
}

// ChromeProfile is the last safe association between a managed Codex account
// and a local Chrome profile. It deliberately contains no filesystem path,
// cookies, or browser tokens. Keeping the association lets the UI show the
// profile that last held an account even after that browser profile changes
// its ChatGPT login.
type ChromeProfile struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	Outcome            string     `json:"outcome"`
	ActiveEmail        string     `json:"activeEmail,omitempty"`
	LastActiveEmail    string     `json:"lastActiveEmail,omitempty"`
	LastManagedAccount string     `json:"lastManagedAccount,omitempty"`
	LastSeenAt         *time.Time `json:"lastSeenAt,omitempty"`
	LastCheckedAt      *time.Time `json:"lastCheckedAt,omitempty"`
}

// SessionMonitor is the safe, per-account projection of Chrome's Codex
// session audit. It contains counts and timestamps only; device IDs, cookies,
// and tokens are never persisted in the account API.
type SessionMonitor struct {
	LastCheckedAt          *time.Time            `json:"lastCheckedAt,omitempty"`
	CodexSessions          *int                  `json:"codexSessions,omitempty"`
	ExcessCodexSessions    int                   `json:"excessCodexSessions"`
	RevokedLastRun         int                   `json:"revokedLastRun"`
	RevokedTotal           int                   `json:"revokedTotal"`
	RevocationDisabled     bool                  `json:"revocationDisabled"`
	CurrentDeviceProtected bool                  `json:"currentDeviceProtected"`
	Outcome                string                `json:"outcome,omitempty"`
	Error                  string                `json:"error,omitempty"`
	CheckHistory           []SessionMonitorCheck `json:"checkHistory,omitempty"`
}

type SessionMonitorCheck struct {
	CheckedAt      time.Time `json:"checkedAt"`
	CodexSessions  *int      `json:"codexSessions,omitempty"`
	ExcessSessions int       `json:"excessCodexSessions"`
	Revoked        int       `json:"revokedLastRun"`
	Outcome        string    `json:"outcome,omitempty"`
	Error          string    `json:"error,omitempty"`
}
