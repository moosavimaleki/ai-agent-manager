package browser

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var accountSwitchKey = []byte("oai/apps/accountSwitchSessions")

// SwitchAccount is the safe, local record retained by ChatGPT's account
// switcher. It contains identity metadata only; tokens and cookies never leave
// the Chrome profile.
type SwitchAccount struct {
	Email        string
	LastLoggedIn int64
}

// DiscoverSwitchAccountActivity reads LevelDB files as immutable byte streams.
// It preserves the last selected account so callers can retain the account ↔
// Chrome-profile association even when the current ChatGPT cookie is expired
// or the sign-in probe fails.
func DiscoverSwitchAccountActivity(profile Profile) ([]SwitchAccount, error) {
	if profile.Path == "" {
		return nil, ErrUnsafeCookiePath
	}
	locations := []string{
		filepath.Join(profile.Path, "Local Storage", "leveldb"),
		filepath.Join(profile.Path, "IndexedDB", "https_chatgpt.com_0.indexeddb.leveldb"),
	}
	var best accountCandidate
	for _, location := range locations {
		entries, err := os.ReadDir(location)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			data, err := os.ReadFile(filepath.Join(location, entry.Name()))
			if err != nil {
				continue
			}
			for offset := 0; ; {
				index := indexOf(data, accountSwitchKey, offset)
				if index < 0 {
					break
				}
				offset = index + len(accountSwitchKey)
				candidate := parseSwitchAccounts(data[offset:])
				if candidate.latest > best.latest || (candidate.latest == best.latest && len(candidate.accounts) > len(best.accounts)) {
					best = candidate
				}
			}
		}
	}
	return best.accounts, nil
}

// DiscoverSwitchAccounts is retained for callers that only need emails.
func DiscoverSwitchAccounts(profile Profile) ([]string, error) {
	accounts, err := DiscoverSwitchAccountActivity(profile)
	if err != nil {
		return nil, err
	}
	emails := make([]string, 0, len(accounts))
	for _, account := range accounts {
		emails = append(emails, account.Email)
	}
	sort.Strings(emails)
	return emails, nil
}

type accountCandidate struct {
	latest   int64
	accounts []SwitchAccount
}

func parseSwitchAccounts(data []byte) accountCandidate {
	start := indexOf(data, []byte("["), 0)
	if start < 0 {
		return accountCandidate{}
	}
	decoder := json.NewDecoder(strings.NewReader(string(data[start:])))
	var values []struct {
		Email        string `json:"email"`
		LastLoggedIn int64  `json:"lastLoggedInAt"`
	}
	if decoder.Decode(&values) != nil {
		return accountCandidate{}
	}
	seen := make(map[string]int64)
	result := accountCandidate{}
	for _, value := range values {
		email := strings.ToLower(strings.TrimSpace(value.Email))
		if email == "" {
			continue
		}
		if previous, ok := seen[email]; !ok || value.LastLoggedIn > previous {
			seen[email] = value.LastLoggedIn
		}
		if value.LastLoggedIn > result.latest {
			result.latest = value.LastLoggedIn
		}
	}
	for email, lastLoggedIn := range seen {
		result.accounts = append(result.accounts, SwitchAccount{Email: email, LastLoggedIn: lastLoggedIn})
	}
	sort.Slice(result.accounts, func(i, j int) bool {
		if result.accounts[i].LastLoggedIn != result.accounts[j].LastLoggedIn {
			return result.accounts[i].LastLoggedIn > result.accounts[j].LastLoggedIn
		}
		return result.accounts[i].Email < result.accounts[j].Email
	})
	return result
}

func AssociateManagedAccounts(emails []string, managed map[string]string) map[string]string {
	result := make(map[string]string)
	byEmail := make(map[string]string, len(managed))
	for accountName, email := range managed {
		if normalized := strings.ToLower(strings.TrimSpace(email)); normalized != "" {
			byEmail[normalized] = accountName
		}
	}
	for _, email := range emails {
		if accountName, ok := byEmail[strings.ToLower(strings.TrimSpace(email))]; ok {
			result[email] = accountName
		}
	}
	return result
}

func indexOf(data, needle []byte, start int) int {
	for index := start; index+len(needle) <= len(data); index++ {
		matched := true
		for offset := range needle {
			if data[index+offset] != needle[offset] {
				matched = false
				break
			}
		}
		if matched {
			return index
		}
	}
	return -1
}
