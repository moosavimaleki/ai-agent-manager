package browser

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverSwitchAccountsAndAssociatesManagedAccounts(t *testing.T) {
	profilePath := t.TempDir()
	levelDB := filepath.Join(profilePath, "Local Storage", "leveldb")
	if err := os.MkdirAll(levelDB, 0700); err != nil {
		t.Fatal(err)
	}
	data := append([]byte("ignored\x00"), accountSwitchKey...)
	data = append(data, []byte(`[{"email":"One@Example.com","lastLoggedInAt":10},{"email":"two@example.com","lastLoggedInAt":20}]`)...)
	if err := os.WriteFile(filepath.Join(levelDB, "000001.log"), data, 0600); err != nil {
		t.Fatal(err)
	}
	emails, err := DiscoverSwitchAccounts(Profile{Path: profilePath})
	if err != nil || len(emails) != 2 || emails[0] != "one@example.com" {
		t.Fatalf("emails=%v err=%v", emails, err)
	}
	activity, err := DiscoverSwitchAccountActivity(Profile{Path: profilePath})
	if err != nil || len(activity) != 2 || activity[0].Email != "two@example.com" || activity[0].LastLoggedIn != 20 {
		t.Fatalf("activity=%#v err=%v", activity, err)
	}
	matched := AssociateManagedAccounts(emails, map[string]string{"first": "ONE@example.com", "other": "none@example.com"})
	if matched["one@example.com"] != "first" || len(matched) != 1 {
		t.Fatalf("matched=%v", matched)
	}
}
