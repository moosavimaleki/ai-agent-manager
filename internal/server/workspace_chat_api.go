package server

import (
	"net/http"
	"strings"
)

const workspaceChatRefreshRecentLimit = 50

// handleAPIChatRefresh refreshes a rendered chat snapshot without using the
// workspace WebSocket. It intentionally only reads the local event store and
// native transcript; it never contacts the Codex app-server.
func handleAPIChatRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/chats/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] != "refresh" {
		http.NotFound(w, r)
		return
	}
	chatID := strings.TrimSpace(parts[0])
	workspaceInvalidateNativeHistoryCacheForChat(chatID)
	snapshot := workspaceChatSnapshot(chatID, workspaceChatRefreshRecentLimit)
	if snapshot == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, snapshot)
}
