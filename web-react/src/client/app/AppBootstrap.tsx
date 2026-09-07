import { lazy, Suspense, useCallback, useEffect, useState } from "react"

const AppRuntime = lazy(() => import("./AppRuntime").then((module) => ({ default: module.AppRuntime })))

type AuthState = "checking" | "ready" | "locked"

function locale() {
  return document.documentElement.lang === "en" ? "en" : "fa"
}

function BootstrapSplash({ message }: { message: string }) {
  const isEnglish = locale() === "en"
  return (
    <div className="abolqasem-splash-screen min-h-[100dvh] overflow-hidden bg-background text-foreground" dir={isEnglish ? "ltr" : "rtl"}>
      <main className="abolqasem-splash" aria-busy="true">
        <div className="abolqasem-splash-aura" />
        <section className="flex flex-col items-center">
          <div className="abolqasem-splash-logo-card" aria-hidden="true">
            <span className="font-logo text-3xl font-bold">A</span>
          </div>
          <div className="abolqasem-splash-brand">
            <h1>Abolqasem</h1>
            <p>{message}</p>
            <div className="abolqasem-splash-loader" aria-hidden="true"><span /></div>
          </div>
        </section>
      </main>
    </div>
  )
}

function PasswordScreen({ error, onSubmit }: { error: string | null; onSubmit: (password: string) => Promise<void> }) {
  const isEnglish = locale() === "en"
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const submit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(password)
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }, [onSubmit, password, submitting])
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 py-10" dir={isEnglish ? "ltr" : "rtl"}>
      <form className="w-full max-w-md space-y-4 rounded-3xl border border-border bg-card p-6 shadow-sm" onSubmit={(event) => void submit(event)}>
        <h1 className="font-logo text-xl uppercase">Abolqasem</h1>
        <p className="text-sm text-muted-foreground">{isEnglish ? "Enter the password to continue." : "برای ادامه رمز عبور را وارد کنید."}</p>
        {error ? <p className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        <input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3" />
        <button type="submit" disabled={submitting || !password} className="h-11 w-full rounded-xl bg-primary px-4 text-primary-foreground disabled:opacity-60">
          {submitting ? (isEnglish ? "Unlocking…" : "در حال باز کردن…") : (isEnglish ? "Unlock" : "باز کردن")}
        </button>
      </form>
    </div>
  )
}

// This is intentionally the real entry component. Importing the authenticated
// runtime from main.tsx made Chrome parse/evaluate the full chat application
// before the tiny auth request had completed, producing a long CPU-only blank
// interval even when the network waterfall was already finished.
export function AppBootstrap() {
  const [state, setState] = useState<AuthState>("checking")
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setState("checking")
    try {
      const response = await fetch("/auth/status", { cache: "no-store", headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error("Unable to verify the session")
      const status = await response.json() as { enabled?: boolean; authenticated?: boolean }
      setState(!status.enabled || status.authenticated ? "ready" : "locked")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      window.setTimeout(() => void refresh(), 500)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const submitPassword = useCallback(async (password: string) => {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password, next: window.location.pathname + window.location.search }),
    })
    if (!response.ok) {
      setState("locked")
      setError(locale() === "en" ? "Incorrect password." : "رمز عبور نادرست است.")
      return
    }
    setError(null)
    await refresh()
  }, [refresh])

  if (state === "checking") return <BootstrapSplash message={locale() === "en" ? "Checking session…" : "در حال بررسی نشست…"} />
  if (state === "locked") return <PasswordScreen error={error} onSubmit={submitPassword} />
  return <Suspense fallback={<BootstrapSplash message={locale() === "en" ? "Loading workspace…" : "در حال بارگذاری محیط…"} />}><AppRuntime /></Suspense>
}
