package server

import (
	"abolqasem/internal/appinfo"
	"abolqasem/internal/state"
	"io/fs"
	"net/http"
	"net/http/pprof"
	"net/url"
	"os"
	"strings"
)

var webFS fs.FS

func SetWebFS(f fs.FS) {
	webFS = f
}

func setupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/state", handleAPIState)
	mux.HandleFunc("/api/sessions", handleAPISessions)
	mux.HandleFunc("/api/search", handleAPISearch)
	mux.HandleFunc("/api/settings", handleAPISettings)
	mux.HandleFunc("/api/codex-manager", handleAPICodexManager)
	mux.HandleFunc("/api/codex-manager/", handleAPICodexManager)
	mux.HandleFunc("/api/custom-providers", handleAPICustomProvider)
	mux.HandleFunc("/api/custom-providers/", handleAPICustomProvider)
	mux.HandleFunc("/api/resources", handleAPIResources)
	mux.HandleFunc("/api/resources/compact", handleAPIResourceCompact)
	mux.HandleFunc("/api/resources/cache", handleAPIResourceCache)
	mux.HandleFunc("/api/resources/checkpoints", handleAPIResourceCheckpoints)
	mux.HandleFunc("/api/resources/archives", handleAPIResourceArchives)
	mux.HandleFunc("/api/resources/attachments", handleAPIResourceAttachments)
	mux.HandleFunc("/api/usage", handleAPIUsage)
	mux.HandleFunc("/api/usage/refresh", handleAPIUsageRefresh)
	mux.HandleFunc("/api/actions/reload-sessions", handleAPIReloadSessions)
	mux.HandleFunc("/api/actions/restart-server", handleAPIRestartServer)
	mux.HandleFunc("/api/hooks/status", handleAPIHooksStatus)
	mux.HandleFunc("/api/agent/status", handleAPIAgentStatus)
	mux.HandleFunc("/api/agent/turn", handleAPIAgentTurn)
	mux.HandleFunc("/api/agent/codex/turn", handleAPICodexTurn)
	mux.HandleFunc("/api/telegram/config", handleAPITelegramConfig)
	mux.HandleFunc("/api/telegram/status", handleAPITelegramStatus)
	mux.HandleFunc("/api/telegram/configure", handleAPITelegramConfigure)
	mux.HandleFunc("/api/telegram/test", handleAPITelegramTest)
	mux.HandleFunc("/api/hook", handleAPIHook)
	mux.HandleFunc("/api/session/", handleAPISessionMessages)
	mux.HandleFunc("/api/chats/", handleAPIChatRefresh)
	mux.HandleFunc("/api/file-preview", handleAPIFilePreview)
	mux.HandleFunc("/api/file-context", handleAPIFileContext)
	mux.HandleFunc("/api/projects/", handleAPIProjects)
	mux.HandleFunc("/api/events", handleAPIEvents)
	mux.HandleFunc("/ws", handleWorkspaceWS)
	mux.HandleFunc("/auth/status", handleWorkspaceAuthStatus)
	mux.HandleFunc("/auth/logout", handleWorkspaceAuthLogout)
	if strings.TrimSpace(os.Getenv(appinfo.EnvPrefix+"_PPROF")) == "1" || strings.TrimSpace(os.Getenv(appinfo.LegacyEnvPrefix+"_PPROF")) == "1" {
		registerPprofRoutes(mux)
	}

	rootFS := fs.FS(os.DirFS("web"))
	if webFS != nil {
		subFS, _ := fs.Sub(webFS, "web")
		rootFS = subFS
	}
	fileServer := http.FileServer(http.FS(rootFS))
	mux.HandleFunc("/legacy", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/legacy/", http.StatusTemporaryRedirect)
	})
	mux.Handle("/legacy/", http.StripPrefix("/legacy/", fileServer))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" ||
			strings.HasPrefix(r.URL.Path, "/_/") || r.URL.Path == "/_" ||
			r.URL.Path == "/settings" || strings.HasPrefix(r.URL.Path, "/settings/") ||
			r.URL.Path == "/chat" || strings.HasPrefix(r.URL.Path, "/chat/") {
			serveAppIndex(w, rootFS)
			return
		}
		if isLocalFileRoute(r.URL.Path) {
			serveAppIndex(w, rootFS)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

func registerPprofRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
}

func serveAppIndex(w http.ResponseWriter, rootFS fs.FS) {
	data, err := fs.ReadFile(rootFS, "index.html")
	if err != nil {
		http.Error(w, "app index not found", http.StatusInternalServerError)
		return
	}
	// The HTML entry point contains references to content-hashed assets. It must
	// always be revalidated after a deploy; otherwise a browser can retain an
	// old index that points at bundles removed by the next build, producing a
	// blank page until site data is cleared manually. Hashed assets themselves
	// remain cacheable by the regular file server.
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(rewriteAppIndexForDocumentLocale(rewriteAppIndexForRootRoute(data)))
}

func rewriteAppIndexForRootRoute(data []byte) []byte {
	content := string(data)
	content = strings.ReplaceAll(content, `href="./`, `href="/`)
	content = strings.ReplaceAll(content, `src="./`, `src="/`)
	return []byte(content)
}

func rewriteAppIndexForDocumentLocale(data []byte) []byte {
	locale := "fa"
	if settings, err := state.LoadSettings(); err == nil {
		normalized := state.NormalizeSettings(settings)
		if normalized.Locale == "fa" || normalized.Locale == "en" {
			locale = normalized.Locale
		}
	}

	dir := "ltr"
	if locale == "fa" {
		dir = "rtl"
	}

	content := string(data)
	replacement := `<html lang="` + locale + `" dir="` + dir + `" data-abolqasem-locale="server">`
	if strings.Contains(content, `<html lang="en" dir="ltr" data-abolqasem-locale="default">`) {
		return []byte(strings.Replace(content, `<html lang="en" dir="ltr" data-abolqasem-locale="default">`, replacement, 1))
	}
	return []byte(strings.Replace(content, `<html lang="en">`, replacement, 1))
}

func isLocalFileRoute(rawPath string) bool {
	if strings.HasPrefix(rawPath, "/api/") || rawPath == "/" {
		return false
	}
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return false
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	path = stripLineSuffix(path)
	if path == "" {
		return false
	}
	return looksLikeLocalFilesystemPath(path)
}

func stripLineSuffix(path string) string {
	if idx := strings.LastIndex(path, ":"); idx > 0 && idx < len(path)-1 {
		suffix := path[idx+1:]
		for _, ch := range suffix {
			if ch < '0' || ch > '9' {
				return path
			}
		}
		return path[:idx]
	}
	return path
}

func looksLikeLocalFilesystemPath(path string) bool {
	slashPath := strings.ReplaceAll(path, "\\", "/")
	return strings.HasPrefix(slashPath, "/home/") ||
		strings.HasPrefix(slashPath, "/Users/") ||
		strings.HasPrefix(slashPath, "/tmp/") ||
		strings.HasPrefix(slashPath, "/var/") ||
		strings.HasPrefix(slashPath, "/private/var/") ||
		isWindowsDrivePath(slashPath)
}

func isWindowsDrivePath(path string) bool {
	if len(path) >= 4 && path[0] == '/' && isASCIIAlpha(path[1]) && path[2] == ':' && path[3] == '/' {
		return true
	}
	return len(path) >= 3 && isASCIIAlpha(path[0]) && path[1] == ':' && path[2] == '/'
}

func isASCIIAlpha(ch byte) bool {
	return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
}
