import { useEffect, useState } from "react";
import {
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import type { AppLocale } from "../../../shared/types";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

type Profile = {
  id: string;
  name: string;
  accounts?: Record<string, string>;
  outcome?: "signed_in" | "partial" | "signed_out" | "error" | "missing" | "pending";
  activeEmail?: string;
  managedAccount?: string;
  managedPlan?: string;
  savedAccounts?: string[];
  lastActiveEmail?: string;
  lastManagedAccount?: string;
  reason?: string;
};

type Device = {
  id: string;
  name: string;
  current: boolean;
  hasCodex: boolean;
};

const t = (locale: AppLocale, fa: string, en: string) =>
  locale === "fa" ? fa : en;

function ScanHelp({ locale }: { locale: AppLocale }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t(locale, "راهنمای بررسی Chrome", "Chrome scan help")}
          className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        dir={locale === "fa" ? "rtl" : "ltr"}
        className="max-w-80 whitespace-normal text-start leading-relaxed"
      >
        {t(
          locale,
          "اسکن، هر پروفایل Chrome را بدون تغییر cookie بررسی می‌کند. «ناقص» یعنی cookie وجود دارد اما ورود ChatGPT کامل نشده است. برای دیدن یا پاک‌سازی نشست‌های Codex، همان ردیف را انتخاب کنید؛ دستگاه فعلی حذف نمی‌شود.",
          "Scanning checks every Chrome profile without changing cookies. Partial means cookies exist but the ChatGPT sign-in is incomplete. Select a row to inspect or clean Codex sessions; the current device is never removed.",
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function statusFor(profile: Profile, locale: AppLocale) {
  switch (profile.outcome) {
    case "signed_in":
      return {
        label: t(locale, "وارد شده", "Signed in"),
        className:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "partial":
      return {
        label: t(locale, "ورود ناقص", "Partial"),
        className:
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "error":
      return {
        label: t(locale, "قابل بررسی نیست", "Check failed"),
        className: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    case "missing":
      return {
        label: t(locale, "پروفایل در دسترس نیست", "Profile unavailable"),
        className: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    case "pending":
      return {
        label: t(locale, "در حال بررسی", "Checking"),
        className: "border-border bg-muted/40 text-muted-foreground",
      };
    default:
      return {
        label: t(locale, "وارد نشده", "Signed out"),
        className: "border-border bg-muted/40 text-muted-foreground",
      };
  }
}

export function BrowserSessionsPanel({
  locale,
  refreshKey = 0,
}: {
  locale: AppLocale;
  refreshKey?: number;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [checkedDevices, setCheckedDevices] = useState(false);
  const [cleanupAccount, setCleanupAccount] = useState("");
  const [cleanupSummary, setCleanupSummary] = useState<string | null>(null);

  async function loadProfiles() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/codex-manager/browser/profiles", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as { profiles?: Profile[]; scannedAt?: string };
      const next = payload.profiles ?? [];
      setProfiles(next);
      setScannedAt(payload.scannedAt ?? null);
      setSelected((current) => current || next[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  async function scanProfiles() {
    setScanning(true);
    setError(null);
    try {
      const response = await fetch("/api/codex-manager/browser/scan", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as { profiles?: Profile[]; scannedAt?: string };
      const next = payload.profiles ?? [];
      setProfiles(next);
      setScannedAt(payload.scannedAt ?? null);
      setSelected((current) => current || next[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  }

  async function loadDevices(profileID = selected) {
    if (!profileID) return;
    setLoading(true);
    setError(null);
    setCheckedDevices(true);
    try {
      const response = await fetch(
        `/api/codex-manager/browser/devices?profileId=${encodeURIComponent(profileID)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as { devices?: Device[] };
      setDevices(payload.devices ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProfiles();
    // The server refreshes sign-in state every 15 minutes. Polling its cached
    // result is cheap and lets an already-open settings tab reflect that work.
    const timer = window.setInterval(() => void loadProfiles(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshKey]);

  const selectedProfile = profiles.find((profile) => profile.id === selected);
  const associatedAccounts = Array.from(
    new Set(
      [
        selectedProfile?.managedAccount ?? "",
        ...Object.values(selectedProfile?.accounts ?? {}),
      ].filter(Boolean),
    ),
  );

  async function openSelectedProfile(profileID = selected) {
    if (!profileID) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/codex-manager/browser/profiles/open?profileId=${encodeURIComponent(profileID)}`,
        { method: "POST", headers: { Accept: "application/json" } },
      );
      if (!response.ok) throw new Error(await response.text());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  async function cleanup() {
    const account = cleanupAccount || associatedAccounts[0];
    if (!selected || !account) return;
    if (
      !dryRun &&
      !window.confirm(
        t(
          locale,
          `همهٔ نشست‌های اضافی حساب «${account}» خارج شوند؟ دستگاه فعلی محافظت می‌شود.`,
          `Revoke extra sessions for “${account}”? The current device stays protected.`,
        ),
      )
    )
      return;
    setLoading(true);
    setError(null);
    setCleanupSummary(null);
    try {
      const response = await fetch(
        `/api/codex-manager/browser/cleanup?profileId=${encodeURIComponent(selected)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account, dryRun }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as {
        cleanup?: { targets?: unknown[]; revoked?: string[] };
      };
      const count = dryRun
        ? (payload.cleanup?.targets?.length ?? 0)
        : (payload.cleanup?.revoked?.length ?? 0);
      setCleanupSummary(
        dryRun
          ? t(
              locale,
              `${count} نشست برای خروج پیشنهاد شد؛ هنوز چیزی حذف نشده است.`,
              `${count} sessions would be revoked; nothing was removed.`,
            )
          : t(
              locale,
              `${count} نشست اضافی خارج شد.`,
              `${count} extra sessions were revoked.`,
            ),
      );
      await loadDevices();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    }
  }

  const counts = profiles.reduce(
    (result, profile) => {
      const key = profile.outcome ?? "unknown";
      result[key] = (result[key] ?? 0) + 1;
      return result;
    },
    {} as Record<string, number>,
  );

  return (
    <section
      className="grid gap-3 rounded-xl border border-border bg-card/30 p-4"
      dir={locale === "fa" ? "rtl" : "ltr"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold">
            {t(locale, "مدیریت Chrome", "Chrome management")}
          </h3>
          <ScanHelp locale={locale} />
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void scanProfiles()}
            disabled={loading || scanning}
          >
            {scanning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ShieldAlert className="size-3.5" />
            )}
            {t(locale, "بررسی پروفایل‌ها", "Scan profiles")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void loadProfiles()}
            disabled={loading || scanning}
            aria-label={t(locale, "به‌روزرسانی", "Refresh")}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
          {t(locale, "پروفایل", "Profiles")}: {profiles.length}
        </span>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
          {t(locale, "وارد", "Signed in")}: {counts.signed_in ?? 0}
        </span>
        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
          {t(locale, "ناقص", "Partial")}: {counts.partial ?? 0}
        </span>
        <span className="rounded-full border border-border bg-muted/40 px-2 py-1 text-muted-foreground">
          {t(locale, "وارد نشده", "Signed out")}: {counts.signed_out ?? 0}
        </span>
        {(counts.error ?? 0) > 0 ? (
          <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
            {t(locale, "خطا", "Errors")}: {counts.error}
          </span>
        ) : null}
        {scannedAt ? (
          <span className="self-center text-muted-foreground">
            {t(locale, "آخرین بررسی: ", "Last checked: ")}
            {new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : undefined, { timeStyle: "short" }).format(new Date(scannedAt))}
          </span>
        ) : null}
      </div>

      <div
        className="overflow-hidden rounded-lg border border-border"
        role="table"
        aria-label={t(locale, "فهرست پروفایل‌های Chrome", "Chrome profiles")}
      >
        <div
          className="hidden grid-cols-[7rem_minmax(8rem,1fr)_minmax(10rem,1.25fr)_minmax(10rem,1.25fr)_minmax(10rem,1.25fr)_5.5rem] gap-3 border-b border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground xl:grid"
          role="row"
        >
          <span role="columnheader">{t(locale, "وضعیت", "Status")}</span>
          <span role="columnheader">{t(locale, "پروفایل", "Profile")}</span>
          <span role="columnheader">
            {t(locale, "حساب فعال ChatGPT", "Active ChatGPT account")}
          </span>
          <span role="columnheader">
            {t(locale, "آخرین حساب این Chrome", "Last account in this Chrome")}
          </span>
          <span role="columnheader">
            {t(locale, "حساب‌های Codex مرتبط", "Associated Codex accounts")}
          </span>
          <span aria-hidden="true" />
        </div>
        {profiles.map((profile) => {
          const status = statusFor(profile, locale);
          const isSelected = profile.id === selected;
          const linkedAccounts = Object.entries(profile.accounts ?? {});
          return (
            <div
              key={profile.id}
              role="row"
              className={`grid gap-2 border-b border-border/60 px-3 py-2.5 text-start text-xs last:border-b-0 xl:grid-cols-[7rem_minmax(8rem,1fr)_minmax(10rem,1.25fr)_minmax(10rem,1.25fr)_minmax(10rem,1.25fr)_5.5rem] xl:items-center ${isSelected ? "bg-primary/5" : "hover:bg-muted/40"}`}
            >
              <button
                type="button"
                className="contents text-start"
                onClick={() => {
                  setSelected(profile.id);
                  setDevices([]);
                  setCheckedDevices(false);
                  setCleanupSummary(null);
                  setError(null);
                }}
              >
              <span role="cell">
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${status.className}`}
                >
                  {status.label}
                </span>
              </span>
              <span role="cell" className="font-medium">
                {profile.name || profile.id}
              </span>
              <span
                role="cell"
                className="truncate text-muted-foreground"
                dir="ltr"
              >
                {profile.activeEmail || "—"}
              </span>
              <span
                role="cell"
                className="min-w-0 text-muted-foreground"
              >
                {profile.lastActiveEmail ? (
                  <span className="block truncate" dir="ltr" title={profile.lastActiveEmail}>
                    {profile.lastActiveEmail}
                    {profile.lastManagedAccount ? ` · ${profile.lastManagedAccount}` : ""}
                  </span>
                ) : "—"}
              </span>
              <span
                role="cell"
                className="min-w-0 text-muted-foreground"
              >
                {linkedAccounts.length ? (
                  <span className="block truncate" title={linkedAccounts.map(([email, name]) => `${name} (${email})`).join(", ")}>
                    {linkedAccounts.map(([email, name]) => `${name} · ${email}`).join(", ")}
                  </span>
                ) : "—"}
              </span>
              </button>
              <span role="cell" className="flex justify-end">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(profile.id);
                    void openSelectedProfile(profile.id);
                  }}
                  disabled={loading || scanning || profile.outcome === "missing"}
                  aria-label={t(locale, `باز کردن Chrome با پروفایل ${profile.name}`, `Open Chrome profile ${profile.name}`)}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </span>
            </div>
          );
        })}
        {profiles.length === 0 && !loading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t(
              locale,
              "هیچ پروفایل Chrome قابل بررسی پیدا نشد.",
              "No inspectable Chrome profile was found.",
            )}
          </p>
        ) : null}
      </div>

      {selectedProfile ? (
        <div className="grid gap-3 rounded-lg border border-border bg-background/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">{selectedProfile.name}</div>
              {selectedProfile.reason ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {selectedProfile.reason}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void openSelectedProfile()}
                disabled={loading || scanning || selectedProfile.outcome === "missing"}
              >
                <ExternalLink className="size-3.5" />
                {t(locale, "باز کردن Chrome", "Open Chrome")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadDevices()}
                disabled={loading || scanning}
              >
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t(locale, "بررسی نشست‌های Codex", "Check Codex sessions")}
              </Button>
            </div>
          </div>
          {associatedAccounts.length ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
              <Select
                value={cleanupAccount || associatedAccounts[0]}
                onValueChange={setCleanupAccount}
                disabled={loading || scanning}
              >
                <SelectTrigger className="h-8 min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent dir={locale === "fa" ? "rtl" : "ltr"}>
                  {associatedAccounts.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                role="switch"
                aria-checked={!dryRun}
                onClick={() => setDryRun((value) => !value)}
                disabled={loading || scanning}
                className={`flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs ${dryRun ? "border-border text-muted-foreground" : "border-amber-500/40 bg-amber-500/10 text-foreground"}`}
              >
                <span
                  className={`relative inline-flex h-4 w-7 rounded-full ${dryRun ? "bg-muted-foreground/30" : "bg-amber-500"}`}
                >
                  <span
                    className={`absolute top-0.5 size-3 rounded-full bg-background transition-transform ${dryRun ? "start-0.5" : "start-3.5"}`}
                  />
                </span>
                {t(locale, "خروج واقعی", "Actually revoke")}
              </button>
              <Button
                size="sm"
                variant={dryRun ? "outline" : "destructive"}
                onClick={() => void cleanup()}
                disabled={loading || scanning}
              >
                {dryRun
                  ? t(locale, "پیش‌نمایش", "Preview")
                  : t(locale, "خارج‌کردن نشست‌های اضافه", "Revoke extra sessions")}
              </Button>
            </div>
          ) : (
            <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
              {t(
                locale,
                "این پروفایل هنوز به حساب مدیریت‌شده‌ای مرتبط نشده است.",
                "This profile is not associated with a managed account yet.",
              )}
            </p>
          )}
        </div>
      ) : null}

      {cleanupSummary ? (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {cleanupSummary}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {checkedDevices && devices.length === 0 && !loading && !error ? (
        <p className="text-xs text-muted-foreground">
          {t(
            locale,
            "نشست Codex دیگری برای این پروفایل پیدا نشد.",
            "No other Codex sessions were found for this profile.",
          )}
        </p>
      ) : null}
      {devices.map((device) => (
        <div
          key={device.id}
          className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-2.5 py-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <ShieldAlert
              className={
                device.current
                  ? "size-3.5 text-emerald-600"
                  : "size-3.5 text-muted-foreground"
              }
            />
            <div className="min-w-0">
              <div className="truncate text-sm">{device.name || device.id}</div>
              <div className="text-xs text-muted-foreground">
                {device.current
                  ? t(locale, "دستگاه فعلی", "Current device")
                  : device.hasCodex
                    ? "Codex"
                    : ""}
              </div>
            </div>
          </div>
          {device.current ? (
            <span className="text-[11px] text-emerald-600">
              {t(locale, "محافظت‌شده", "Protected")}
            </span>
          ) : null}
        </div>
      ))}
    </section>
  );
}
