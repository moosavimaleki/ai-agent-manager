import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { AbolqasemSplashLogo } from "../components/AbolqasemSplashLogo"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { TooltipProvider } from "../components/ui/tooltip"
import { Bell, Loader2, Settings2, X } from "lucide-react"
import { getAppearanceThemeClassName, useDocumentAppearanceTheme, useReaderAppearanceSettings } from "../components/appearance/ReaderAppearance"
import { APP_NAME, SDK_CLIENT_APP } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
import { cn } from "../lib/utils"
import { READER_MODE_CHANGE_EVENT } from "./chatFocusPolicy"
import { useAbolqasemState, type SessionForkOperation } from "./useAbolqasemState"
import { chatRoute, hookNotificationSettingsRoute, settingsRoute } from "./routes"
import type { AppSettingsSnapshot } from "../../shared/types"
import { getDictionary, getLocaleDirection, LOCALE_STORAGE_KEY, normalizeLocale } from "../i18n"
import { I18nProvider } from "../i18n/context"

// These screens are not needed to open or resume a chat. Keeping them out of
// the entry chunk prevents settings/editor dependencies from blocking the
// initial chat hydration on slower CPUs.
const SettingsPage = lazy(() => import("./SettingsPage").then((module) => ({ default: module.SettingsPage })))
const FileRoutePage = lazy(() => import("./FileRoutePage").then((module) => ({ default: module.FileRoutePage })))
const AbolqasemSidebar = lazy(() => import("./AbolqasemSidebar").then((module) => ({ default: module.AbolqasemSidebar })))
const LocalProjectsPage = lazy(() => import("./LocalProjectsPage").then((module) => ({ default: module.LocalProjectsPage })))
// The chat transcript includes markdown/highlighting and message renderers.
// Load it only after the authenticated application shell has mounted so the
// sidebar and its initial state requests are never blocked on that work.
const ChatPage = lazy(() => import("./ChatPage").then((module) => ({ default: module.ChatPage })))

const VERSION_SEEN_STORAGE_KEY = "abolqasem:last-seen-version"
const SPLASH_MIN_VISIBLE_MS = 420
// Keep a very short floor to avoid a single-frame flash, but never hold the UI
// after the sidebar and active chat are ready.
const STARTUP_SPLASH_MIN_VISIBLE_MS = 160
const HOOK_TOAST_TIMEOUT_MS = 8000

type AppAuthState = { status: "checking" } | { status: "ready" } | { status: "locked"; error: string | null }

export interface HookStreamEvent {
  source?: string
  event_key?: string
  session_key?: string
  session_id?: string
  chat_id?: string
  session_name?: string
  project_name?: string
  hook_event_name?: string
  response_complete?: boolean
  updated_at?: string
}

interface HookUpdateToastState {
  id: string
  chatId: string
  sessionName: string
  projectName: string
  mode: "follow" | "notice"
}

export function getHookToastMode(appSettings: AppSettingsSnapshot | null): "follow" | "notice" | null {
  const hookNotifications = appSettings?.management?.hookNotifications
  if (!hookNotifications?.enabled) return null
  if (hookNotifications.followMode === "off") return null
  return hookNotifications.followMode === "notice" ? "notice" : "follow"
}

export function shouldShowHookUpdateToast(event: HookStreamEvent | null, activeChatId: string | null, appSettings: AppSettingsSnapshot | null) {
  return Boolean(
    event?.source === "hook" && event.response_complete === true && event.chat_id && event.chat_id !== activeChatId && getHookToastMode(appSettings)
  )
}

function SplashScreen({
  locale,
  appearanceClassName,
  title,
  subtitle,
}: {
  locale: "fa" | "en"
  appearanceClassName?: string
  title: string
  subtitle: string
}) {
  return (
    <div
      dir={getLocaleDirection(locale)}
      className={cn("abolqasem-splash-screen min-h-[100dvh] overflow-hidden bg-background text-foreground", appearanceClassName)}
    >
      <main className="abolqasem-splash" aria-label={`${title} loading screen`}>
        <div className="abolqasem-splash-aura" />
        <section className="flex flex-col items-center">
          <div className="abolqasem-splash-logo-card">
            <AbolqasemSplashLogo className="abolqasem-splash-logo" />
          </div>
          <div className="abolqasem-splash-brand">
            <h1>{title}</h1>
            <p>{subtitle}</p>
            <div className="abolqasem-splash-loader" aria-hidden="true">
              <span />
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

function HookUpdateToast({
  toast,
  locale,
  onOpen,
  onOpenSettings,
  onDismiss,
}: {
  toast: HookUpdateToastState
  locale: "fa" | "en"
  onOpen: () => void
  onOpenSettings: () => void
  onDismiss: () => void
}) {
  const [progressActive, setProgressActive] = useState(false)
  const title = locale === "fa" ? "سشن به‌روزرسانی شد" : "Session updated"
  const dismissLabel = locale === "fa" ? "بستن" : "Dismiss"
  const settingsLabel = locale === "fa" ? "تنظیمات" : "Settings"
  const isFollowMode = toast.mode === "follow"
  const primaryLabel = isFollowMode ? (locale === "fa" ? "رفتن" : "Open") : locale === "fa" ? "ماندن" : "Stay"
  const secondaryLabel = isFollowMode ? (locale === "fa" ? "ماندن" : "Stay") : locale === "fa" ? "باز کردن" : "Open"
  const isRtl = getLocaleDirection(locale) === "rtl"
  const sessionName = toast.sessionName || (locale === "fa" ? "سشن" : "Session")

  useEffect(() => {
    setProgressActive(false)
    const rafId = window.requestAnimationFrame(() => {
      setProgressActive(true)
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [toast.id])

  return (
    <div
      role="status"
      aria-live="polite"
      dir={getLocaleDirection(locale)}
      className={cn(
        "fixed top-4 z-[1100] w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg pointer-events-auto",
        isRtl ? "left-4" : "right-4"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Bell className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-0.5 truncate text-sm text-muted-foreground">{sessionName}</div>
          {toast.projectName ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{toast.projectName}</div> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={isFollowMode ? onOpen : onDismiss}
              className="relative overflow-hidden border border-border/70 bg-muted/70 text-foreground hover:bg-muted"
            >
              <span aria-hidden="true" className="absolute inset-0 bg-muted/70" />
              <span
                aria-hidden="true"
                className="absolute inset-y-0 start-0 bg-primary/55 transition-[width] ease-linear"
                style={{
                  width: progressActive ? "100%" : "0%",
                  transitionDuration: `${HOOK_TOAST_TIMEOUT_MS}ms`,
                }}
              />
              <span
                aria-hidden="true"
                className="absolute inset-y-0 start-0 w-px bg-primary/85"
                style={{
                  insetInlineStart: progressActive ? "calc(100% - 1px)" : "0%",
                  transitionDuration: `${HOOK_TOAST_TIMEOUT_MS}ms`,
                  transitionProperty: "inset-inline-start",
                  transitionTimingFunction: "linear",
                }}
              />
              <span className="relative z-10">{primaryLabel}</span>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={isFollowMode ? onDismiss : onOpen}>
              {secondaryLabel}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onOpenSettings}>
              <Settings2 className="me-1 h-4 w-4" />
              {settingsLabel}
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}

function providerDisplayName(provider: SessionForkOperation["targetProvider"]) {
  switch (provider) {
    case "claude":
      return "Claude"
    case "codex":
      return "Codex"
    default:
      return ""
  }
}

function SessionForkLockOverlay({ operation, locale }: { operation: SessionForkOperation; locale: "fa" | "en" }) {
  const providerName = providerDisplayName(operation.targetProvider)
  const title =
    locale === "fa"
      ? operation.kind === "convert_preview"
        ? "در حال آماده‌سازی Fork"
        : operation.kind === "convert"
          ? `در حال ساخت سشن ${providerName}`
          : "در حال Fork کردن چت"
      : operation.kind === "convert_preview"
        ? "Preparing fork"
        : operation.kind === "convert"
          ? `Creating ${providerName} session`
          : "Forking chat"
  const detail =
    locale === "fa"
      ? "چند لحظه صبر کنید؛ تاریخچه و فایل native سشن در حال آماده‌سازی است."
      : "Please wait while the chat history and native session file are prepared."

  return (
    <div
      className="fixed inset-0 z-[1000] flex cursor-wait items-center justify-center bg-background/70 px-4 text-foreground backdrop-blur-md"
      role="status"
      aria-live="polite"
      aria-busy="true"
      dir={getLocaleDirection(locale)}
    >
      <div className="w-full max-w-md overflow-hidden rounded-[2rem] border border-border/70 bg-card/95 shadow-2xl">
        <div className="relative p-7">
          <div className="absolute -top-16 end-8 h-36 w-36 rounded-full bg-primary/15 blur-3xl" aria-hidden="true" />
          <div className="relative flex items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold">{title}</div>
              <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">{operation.sourceTitle}</div>
              <div className="mt-4 rounded-2xl border border-border/60 bg-muted/35 px-4 py-3 text-sm text-muted-foreground">{detail}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function useMinimumVisibility(visible: boolean, minimumVisibleMs = SPLASH_MIN_VISIBLE_MS) {
  const [isVisible, setIsVisible] = useState(visible)
  const visibleSinceRef = useRef(visible ? performance.now() : 0)

  useEffect(() => {
    if (visible) {
      visibleSinceRef.current = performance.now()
      setIsVisible(true)
      return
    }

    if (!isVisible) return

    const elapsedMs = Math.max(0, performance.now() - visibleSinceRef.current)
    const delayMs = Math.max(0, minimumVisibleMs - elapsedMs)
    const timeoutId = window.setTimeout(() => {
      setIsVisible(false)
    }, delayMs)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [isVisible, minimumVisibleMs, visible])

  return isVisible
}

export function getAppAuthStateFromStatus(payload: { enabled?: boolean; authenticated?: boolean }): AppAuthState {
  if (!payload.enabled || payload.authenticated) {
    return { status: "ready" }
  }

  return { status: "locked", error: null }
}

export function shouldRetryAuthStatusRequest(responseOk: boolean | null) {
  return responseOk !== true
}

export function shouldShowStartupSplash(initialBootComplete: boolean, sidebarReady: boolean, chatReady: boolean) {
  return !initialBootComplete && (!sidebarReady || !chatReady)
}

export function shouldRedirectToChangelog(pathname: string, currentVersion: string, seenVersion: string | null) {
  return pathname === "/" && Boolean(currentVersion) && seenVersion !== currentVersion
}

export function shouldPlayChatNotificationSound(
  appSettings: AppSettingsSnapshot | null,
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  return Boolean(appSettings) && shouldPlayChatSound(preference, doc)
}

export function applyDocumentLocale(
  localeValue: string | null | undefined,
  root: Pick<HTMLElement, "lang" | "dir"> = document.documentElement,
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage
) {
  const locale = normalizeLocale(localeValue)
  root.lang = locale
  root.dir = getLocaleDirection(locale)
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Locale still applies when localStorage is unavailable.
  }
  return locale
}

export function getDocumentBootstrapLocale(root: Pick<HTMLElement, "lang"> = document.documentElement) {
  return normalizeLocale(root.lang)
}

function AbolqasemLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useAbolqasemState(params.chatId ?? null)
  const [appearanceSettings] = useReaderAppearanceSettings()
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const showMobileOpenButton = location.pathname === "/"
  const currentVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const settingsLocale = state.appSettings?.locale
  const locale = settingsLocale ? normalizeLocale(settingsLocale) : getDocumentBootstrapLocale()
  const [initialBootComplete, setInitialBootComplete] = useState(false)
  const bootReady = state.sidebarReady && state.chatReady
  const showStartupSplash = useMinimumVisibility(
    shouldShowStartupSplash(initialBootComplete, state.sidebarReady, state.chatReady),
    STARTUP_SPLASH_MIN_VISIBLE_MS
  )
  const previousSidebarDataRef = useRef<ReturnType<typeof useAbolqasemState>["sidebarData"] | null>(null)
  const activeChatIdRef = useRef(state.activeChatId)
  const appSettingsRef = useRef(state.appSettings)
  const isReaderOpenRef = useRef(false)
  const [isReaderOpen, setIsReaderOpen] = useState(false)
  const hookEventKeysRef = useRef<Set<string>>(new Set())
  const [hookToast, setHookToast] = useState<HookUpdateToastState | null>(null)
  const handleSidebarCreateChat = useCallback(
    (projectId: string) => {
      void state.handleCreateChat(projectId)
    },
    [state.handleCreateChat]
  )
  const handleSidebarForkChat = useCallback(
    (chat: Parameters<typeof state.handleForkChat>[0]) => {
      void state.handleForkChat(chat)
    },
    [state.handleForkChat]
  )
  const handleSidebarConvertChat = useCallback(
    (chat: Parameters<typeof state.handleConvertChat>[0], provider: Parameters<typeof state.handleConvertChat>[1]) => {
      void state.handleConvertChat(chat, provider)
    },
    [state.handleConvertChat]
  )
  const handleSidebarRenameChat = useCallback(
    (chat: Parameters<typeof state.handleRenameChat>[0]) => {
      void state.handleRenameChat(chat)
    },
    [state.handleRenameChat]
  )
  const handleSidebarRenameProject = useCallback(
    (projectId: string, sidebarTitle: string | undefined, realTitle: string) => {
      void state.handleRenameProject(projectId, sidebarTitle, realTitle)
    },
    [state.handleRenameProject]
  )
  const handleSidebarArchiveChat = useCallback(
    (chat: Parameters<typeof state.handleArchiveChat>[0]) => {
      void state.handleArchiveChat(chat)
    },
    [state.handleArchiveChat]
  )
  const handleOpenArchivedChat = useCallback(
    (chatId: string) => {
      void state.handleOpenArchivedChat(chatId)
    },
    [state.handleOpenArchivedChat]
  )
  const handleOpenAddProjectModal = useCallback(() => {
    state.openAddProjectModal()
  }, [state])
  const handleSidebarDeleteChat = useCallback(
    (chat: Parameters<typeof state.handleDeleteChat>[0]) => {
      void state.handleDeleteChat(chat)
    },
    [state.handleDeleteChat]
  )
  const handleSidebarCopyPath = useCallback(
    (localPath: string) => {
      void state.handleCopyPath(localPath)
    },
    [state.handleCopyPath]
  )
  const handleSidebarOpenExternalPath = useCallback(
    (action: "open_finder" | "open_editor", localPath: string) => {
      void state.handleOpenExternalPath(action, localPath)
    },
    [state.handleOpenExternalPath]
  )
  const handleSidebarHideProject = useCallback(
    (projectId: string) => {
      void state.handleHideProject(projectId)
    },
    [state.handleHideProject]
  )
  const handleSidebarReorderProjectGroups = useCallback(
    (projectIds: string[]) => {
      void state.handleReorderProjectGroups(projectIds)
    },
    [state.handleReorderProjectGroups]
  )
  const handleOpenChangelog = useCallback(() => {
    navigate(settingsRoute("changelog"))
  }, [navigate])
  const sidebarElement = useMemo(
    () => (
      <Suspense fallback={<SidebarLoading />}>
        <AbolqasemSidebar
          data={state.sidebarData}
          activeChatId={state.activeChatId}
          connectionStatus={state.connectionStatus}
          ready={state.sidebarReady}
          pendingArchiveChatIds={state.pendingArchiveChatIds}
          open={state.sidebarOpen}
          collapsed={state.sidebarCollapsed}
          showMobileOpenButton={showMobileOpenButton}
          onOpen={state.openSidebar}
          onClose={state.closeSidebar}
          onCollapse={state.collapseSidebar}
          onExpand={state.expandSidebar}
          onCreateChat={handleSidebarCreateChat}
          onForkChat={handleSidebarForkChat}
          onConvertChat={handleSidebarConvertChat}
          currentProjectId={state.activeProjectId}
          creatingChatProjectId={state.creatingChatProjectId}
          keybindings={state.keybindings}
          onRenameChat={handleSidebarRenameChat}
          onArchiveChat={handleSidebarArchiveChat}
          onPinChat={state.handlePinChat}
          onReorderPinnedChats={state.handleReorderPinnedChats}
          onOpenArchivedChat={handleOpenArchivedChat}
          onDeleteChat={handleSidebarDeleteChat}
          onOpenAddProjectModal={handleOpenAddProjectModal}
          onCopyPath={handleSidebarCopyPath}
          onOpenExternalPath={handleSidebarOpenExternalPath}
          onRenameProject={handleSidebarRenameProject}
          onHideProject={handleSidebarHideProject}
          onReorderProjectGroups={handleSidebarReorderProjectGroups}
          editorLabel={state.editorLabel}
          updateSnapshot={state.updateSnapshot}
          onOpenChangelog={handleOpenChangelog}
        />
      </Suspense>
    ),
    [
      handleOpenChangelog,
      handleOpenAddProjectModal,
      handleSidebarCopyPath,
      handleSidebarCreateChat,
      handleSidebarConvertChat,
      handleSidebarArchiveChat,
      state.handlePinChat,
      handleSidebarDeleteChat,
      handleOpenArchivedChat,
      handleSidebarForkChat,
      handleSidebarOpenExternalPath,
      handleSidebarRenameProject,
      handleSidebarRenameChat,
      handleSidebarReorderProjectGroups,
      handleSidebarHideProject,
      showMobileOpenButton,
      state.activeChatId,
      state.activeProjectId,
      state.keybindings,
      state.closeSidebar,
      state.collapseSidebar,
      state.connectionStatus,
      state.editorLabel,
      state.expandSidebar,
      state.openSidebar,
      state.pendingArchiveChatIds,
      state.sidebarCollapsed,
      state.sidebarData,
      state.sidebarOpen,
      state.sidebarReady,
      state.updateSnapshot,
      state.creatingChatProjectId,
    ]
  )

  useEffect(() => {
    if (!bootReady || initialBootComplete) return
    setInitialBootComplete(true)
  }, [bootReady, initialBootComplete])

  useEffect(() => {
    activeChatIdRef.current = state.activeChatId
    appSettingsRef.current = state.appSettings
  }, [state.activeChatId, state.appSettings])

  useEffect(() => {
    if (!isReaderOpen) return
    setHookToast(null)
  }, [isReaderOpen])

  useEffect(() => {
    function handleReaderModeChange(event: Event) {
      const detail = event instanceof CustomEvent ? (event.detail as { open?: boolean } | undefined) : undefined
      const nextOpen = Boolean(detail?.open)
      isReaderOpenRef.current = nextOpen
      setIsReaderOpen(nextOpen)
    }

    window.addEventListener(READER_MODE_CHANGE_EVENT, handleReaderModeChange)
    return () => window.removeEventListener(READER_MODE_CHANGE_EVENT, handleReaderModeChange)
  }, [])

  useEffect(() => {
    return state.socket.subscribe<null, HookStreamEvent>(
      { type: "global-events" },
      () => {
        // Global events have no initial state. The tiny subscribe snapshot is
        // intentionally ignored; only later event envelopes are actionable.
      },
      (event) => {
        if (!event || event.source !== "hook") return
        if (isReaderOpenRef.current) return

        if (!shouldShowHookUpdateToast(event, activeChatIdRef.current, appSettingsRef.current)) return

        const eventKey = event.event_key || `${event.chat_id ?? ""}:${event.updated_at ?? ""}`
        if (eventKey && hookEventKeysRef.current.has(eventKey)) return
        if (eventKey) {
          hookEventKeysRef.current.add(eventKey)
          if (hookEventKeysRef.current.size > 80) {
            hookEventKeysRef.current.clear()
            hookEventKeysRef.current.add(eventKey)
          }
        }

        const toastMode = getHookToastMode(appSettingsRef.current)
        if (!toastMode) return

        setHookToast({
          id: eventKey || String(Date.now()),
          chatId: event.chat_id || "",
          sessionName: event.session_name || event.session_id || "",
          projectName: event.project_name || "",
          mode: toastMode,
        })
      }
    )
  }, [state.socket])

  useEffect(() => {
    if (!hookToast) return
    const timeout = window.setTimeout(() => {
      if (hookToast.mode === "follow" && !isReaderOpenRef.current) {
        navigate(chatRoute(hookToast.chatId))
      }
      setHookToast((current) => (current?.id === hookToast.id ? null : current))
    }, HOOK_TOAST_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [hookToast, navigate])

  useEffect(() => {
    const seenVersion = window.localStorage.getItem(VERSION_SEEN_STORAGE_KEY)
    const shouldRedirect = shouldRedirectToChangelog(location.pathname, currentVersion, seenVersion)
    window.localStorage.setItem(VERSION_SEEN_STORAGE_KEY, currentVersion)
    if (!shouldRedirect) return
    navigate(settingsRoute("changelog"), { replace: true })
  }, [currentVersion, location.pathname, navigate])

  useLayoutEffect(() => {
    document.title = APP_NAME
  }, [location.key])

  useEffect(() => {
    function handlePageShow() {
      document.title = APP_NAME
    }

    function handlePageHide() {
      document.title = APP_NAME
    }

    window.addEventListener("pageshow", handlePageShow)
    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pageshow", handlePageShow)
      window.removeEventListener("pagehide", handlePageHide)
    }
  }, [])

  useEffect(() => {
    const notificationCount = getNotificationTitleCount(state.sidebarData)
    document.title = notificationCount > 0 ? `[${notificationCount}] ${APP_NAME}` : APP_NAME
  }, [state.sidebarData])

  useEffect(() => {
    if (!settingsLocale) return
    applyDocumentLocale(settingsLocale)
  }, [settingsLocale])

  useEffect(() => {
    const burstCount = getChatSoundBurstCount(previousSidebarDataRef.current, state.sidebarData)
    previousSidebarDataRef.current = state.sidebarData

    if (burstCount <= 0) return
    if (!shouldPlayChatNotificationSound(state.appSettings, chatSoundPreference)) return

    void playChatNotificationSound(chatSoundId, burstCount).catch(() => undefined)
  }, [chatSoundId, chatSoundPreference, state.appSettings, state.sidebarData])

  if (showStartupSplash) {
    return (
      <I18nProvider locale={locale}>
        <SplashScreen
          locale={locale}
          appearanceClassName={getAppearanceThemeClassName(appearanceSettings)}
          title={APP_NAME}
          subtitle={getDictionary(locale).common.loading}
        />
      </I18nProvider>
    )
  }

  return (
    <I18nProvider locale={locale}>
      <div className={cn("flex h-[100dvh] min-h-[100dvh] overflow-hidden bg-background text-foreground", getAppearanceThemeClassName(appearanceSettings))}>
        {sidebarElement}
        <Outlet context={state} />
        {hookToast && !isReaderOpen ? (
          <HookUpdateToast
            toast={hookToast}
            locale={locale}
            onOpen={() => {
              navigate(chatRoute(hookToast.chatId))
              setHookToast(null)
            }}
            onOpenSettings={() => {
              navigate(hookNotificationSettingsRoute())
              setHookToast(null)
            }}
            onDismiss={() => setHookToast(null)}
          />
        ) : null}
        {state.sessionForkOperation ? <SessionForkLockOverlay operation={state.sessionForkOperation} locale={locale} /> : null}
      </div>
    </I18nProvider>
  )
}

export function App() {
  const [appearanceSettings] = useReaderAppearanceSettings()
  useDocumentAppearanceTheme(appearanceSettings)

  return (
    <TooltipProvider>
      <AppDialogProvider>
        <Routes>
          <Route element={<AbolqasemLayout />}>
            <Route path="/" element={<Suspense fallback={<RouteLoading />}><LocalProjectsPage /></Suspense>} />
            <Route path="/settings" element={<Navigate to={settingsRoute("general")} replace />} />
            <Route path="/settings/:sectionId" element={<LegacySettingsRedirect />} />
            <Route path="/chat/:chatId" element={<LegacyChatRedirect />} />
            <Route path="/_/settings" element={<Navigate to={settingsRoute("general")} replace />} />
            <Route path="/_/settings/:sectionId" element={<Suspense fallback={<RouteLoading />}><SettingsPage /></Suspense>} />
            <Route path="/_/chat/:chatId" element={<Suspense fallback={<RouteLoading />}><ChatPage /></Suspense>} />
          </Route>
          <Route path="*" element={<Suspense fallback={<RouteLoading />}><FileRoutePage /></Suspense>} />
        </Routes>
      </AppDialogProvider>
    </TooltipProvider>
  )
}

function RouteLoading() {
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center bg-background text-muted-foreground" aria-busy="true">
      <Loader2 className="size-5 animate-spin" />
    </main>
  )
}

function SidebarLoading() {
  return (
    <aside className="hidden h-full w-[275px] shrink-0 flex-col gap-3 border-e border-border bg-card p-3 md:flex" aria-busy="true">
      <div className="h-8 w-28 animate-pulse rounded-md bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="space-y-2 pt-2">
        <div className="h-8 animate-pulse rounded-md bg-muted" />
        <div className="h-8 animate-pulse rounded-md bg-muted" />
        <div className="h-8 animate-pulse rounded-md bg-muted" />
      </div>
    </aside>
  )
}

function LegacyChatRedirect() {
  const params = useParams()
  return <Navigate to={params.chatId ? chatRoute(params.chatId) : "/"} replace />
}

function LegacySettingsRedirect() {
  const params = useParams()
  return <Navigate to={settingsRoute(params.sectionId ?? "general")} replace />
}
