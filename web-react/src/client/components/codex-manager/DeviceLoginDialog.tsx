import { useEffect, useRef, useState } from "react"
import { Check, Copy, Loader2 } from "lucide-react"
import type { AppLocale } from "../../../shared/types"
import { Button } from "../ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog"

type DeviceCode = { loginId: string; verificationUrl: string; userCode: string; expiresInSeconds: number }
type LoginStatus = "idle" | "starting" | "pending" | "completed" | "failed"

function text(locale: AppLocale, fa: string, en: string) { return locale === "fa" ? fa : en }

export function DeviceLoginDialog({
  locale,
  open,
  onOpenChange,
  onCompleted,
  initialAccountName = "",
  replaceExisting = false,
}: {
  locale: AppLocale
  open: boolean
  onOpenChange: (open: boolean) => void
  onCompleted: (accountName: string) => Promise<void>
  initialAccountName?: string
  replaceExisting?: boolean
}) {
  const [accountName, setAccountName] = useState("")
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [status, setStatus] = useState<LoginStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const closing = useRef(false)

  async function cancelActiveLogin() {
    if (!code?.loginId) return
    try { await fetch(`/api/codex-manager/login/${encodeURIComponent(code.loginId)}`, { method: "DELETE" }) } catch { /* best-effort cleanup */ }
  }

  useEffect(() => () => { void cancelActiveLogin() }, [code?.loginId])

  useEffect(() => {
    if (open && !code) setAccountName(initialAccountName)
  }, [code, initialAccountName, open])

  useEffect(() => {
    if (!code?.loginId || status !== "pending") return
    let cancelled = false
    const expiresAt = Date.now() + code.expiresInSeconds * 1000
    setRemaining(code.expiresInSeconds)
    const countdown = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setRemaining(next)
      if (next === 0) {
        window.clearInterval(countdown)
        setStatus("failed")
        setError(text(locale, "کد ورود منقضی شد؛ دوباره تلاش کنید.", "The device code expired; start a new attempt."))
        void cancelActiveLogin()
      }
    }, 1000)
    const timer = window.setInterval(() => {
      void fetch(`/api/codex-manager/login/${encodeURIComponent(code.loginId)}`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(await response.text())
          return await response.json() as { status: "pending" | "completed" | "failed"; error?: string }
        })
        .then(async (result) => {
          if (cancelled || result.status === "pending") return
          window.clearInterval(timer)
          if (result.status === "completed") {
            setStatus("completed")
            // The authentication result is authoritative. A subsequent quota
            // refresh can fail independently, so do not falsely report that
            // the just-finished login failed or restart the device flow.
            try {
              await onCompleted(accountName.trim())
            } catch (cause) {
              if (!cancelled) {
                setError(cause instanceof Error ? cause.message : String(cause))
              }
            }
            return
          }
          setStatus("failed")
          setError(result.error ?? text(locale, "ورود ناموفق بود.", "Device login failed."))
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          window.clearInterval(timer)
          setStatus("failed")
          setError(cause instanceof Error ? cause.message : String(cause))
        })
    }, 1500)
    return () => { cancelled = true; window.clearInterval(timer); window.clearInterval(countdown) }
  }, [code?.loginId, locale, onCompleted, status])

  async function start() {
    if (!accountName.trim() || status === "starting") return
    setStatus("starting")
    setError(null)
    try {
      const response = await fetch("/api/codex-manager/login", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name: accountName.trim(), replace: replaceExisting }),
      })
      if (!response.ok) throw new Error(await response.text())
      const next = await response.json() as DeviceCode
      setCode(next)
      setStatus("pending")
    } catch (cause) {
      setStatus("failed")
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function copyCode() {
    if (!code) return
    await navigator.clipboard?.writeText(code.userCode)
    setCopied(true)
  }

  async function openSignInPage() {
    if (!code) return
    setError(null)
    // A re-login must continue in the Chrome profile historically associated
    // with this account; opening a raw target=_blank link would silently use
    // whichever browser profile happens to be the default.
    if (replaceExisting && accountName.trim()) {
      try {
        const response = await fetch(`/api/codex-manager/accounts/${encodeURIComponent(accountName.trim())}/chrome-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ verificationUrl: code.verificationUrl }),
        })
        if (!response.ok) throw new Error(await response.text())
        return
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return
      }
    }
    window.open(code.verificationUrl, "_blank", "noopener,noreferrer")
  }

  async function close() {
    if (closing.current) return
    closing.current = true
    await cancelActiveLogin()
    setCode(null)
    setStatus("idle")
    setError(null)
    closing.current = false
    onOpenChange(false)
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!next) void close(); else onOpenChange(true) }}>
    <DialogContent size="sm" dir={locale === "fa" ? "rtl" : "ltr"} hideClose={status === "starting"}>
      <DialogHeader>
        <DialogTitle>{replaceExisting ? text(locale, "ورود دوباره به حساب Codex", "Re-login to Codex account") : text(locale, "افزودن حساب Codex", "Add Codex account")}</DialogTitle>
        <DialogDescription>{replaceExisting ? text(locale, "اطلاعات ورود این حساب با ورود جدید جایگزین می‌شود؛ token هیچ‌وقت در مرورگر Abolqasem نمایش داده نمی‌شود.", "This account's sign-in will be replaced; tokens are never shown in Abolqasem's browser UI.") : text(locale, "ورود در پنجرهٔ رسمی Codex انجام می‌شود؛ token هیچ‌وقت در مرورگر Abolqasem نمایش داده نمی‌شود.", "Sign in through Codex's official device page; tokens are never shown in Abolqasem's browser UI.")}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-3">
        {!code ? <label className="grid gap-1.5 text-sm font-medium"><span>{text(locale, "نام حساب", "Account name")}</span><input autoFocus value={accountName} disabled={status === "starting" || replaceExisting} readOnly={replaceExisting} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring" onChange={(event) => setAccountName(event.target.value)} placeholder="personal" /></label> : <>
          <button type="button" className="w-fit text-sm text-primary underline underline-offset-4" onClick={() => void openSignInPage()}>{text(locale, "باز کردن صفحهٔ ورود", "Open sign-in page")}</button>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/35 p-3"><code dir="ltr" className="text-lg font-semibold tracking-[0.16em]">{code.userCode}</code><Button type="button" size="sm" variant="outline" onClick={() => void copyCode()}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? text(locale, "کپی شد", "Copied") : text(locale, "کپی", "Copy")}</Button></div>
          {status === "pending" ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{text(locale, "منتظر تأیید ورود…", "Waiting for sign-in confirmation…")} <span dir="ltr">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span></p> : null}
          {status === "completed" ? <p className="text-sm text-emerald-600 dark:text-emerald-400">{text(locale, "حساب افزوده شد.", "Account added.")}</p> : null}
        </>}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => void close()} disabled={status === "starting"}>{text(locale, "انصراف", "Cancel")}</Button>
        {!code ? <Button type="button" onClick={() => void start()} disabled={!accountName.trim() || status === "starting"}>{status === "starting" ? <Loader2 className="size-3.5 animate-spin" /> : null}{text(locale, "گرفتن کد ورود", "Get sign-in code")}</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
