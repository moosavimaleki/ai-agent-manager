import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Info,
  LogIn,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";
import type { AppLocale } from "../../../shared/types";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export type QuotaWindow = {
  label: string;
  remainingPercent: number;
  resetAt?: string;
  resetAfterSeconds?: number;
  reached?: boolean;
};
export type QuotaLimit = {
  id: string;
  name?: string;
  limitReached?: boolean;
  windows: QuotaWindow[];
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
};
export type Account = {
  name: string;
  email?: string;
  accountId?: string;
  plan?: string;
  state?: string;
  active?: boolean;
  pinned?: boolean;
  tokenExpiresAt?: string;
  lastCheckedAt?: string;
  lastRefreshAt?: string;
  statusMessage?: string;
  rateLimits?: {
    limits?: QuotaLimit[];
    reachedType?: string;
    fetchedAt?: string;
    error?: string;
  };
  sessionMonitor?: {
    lastCheckedAt?: string;
    codexSessions?: number;
    excessCodexSessions?: number;
    revokedLastRun?: number;
    revokedTotal?: number;
    revocationDisabled?: boolean;
    currentDeviceProtected?: boolean;
    outcome?: string;
    error?: string;
    checkHistory?: Array<{
      checkedAt?: string;
      codexSessions?: number;
      excessCodexSessions?: number;
      revokedLastRun?: number;
      outcome?: string;
      error?: string;
    }>;
  };
  chromeProfile?: AccountChromeProfile;
};
type Recommendation = {
  account?: string;
  label?: string;
  reason?: string;
  recommendable?: boolean;
  remaining?: number;
  target?: number;
  health?: number;
  score?: number;
};
type RecommendationResponse = {
  best?: Recommendation;
  results?: Record<string, Recommendation>;
  Best?: Recommendation;
  Results?: Record<string, Recommendation>;
};
type BrowserProfile = {
  id: string;
  name: string;
  accounts?: Record<string, string>;
  outcome?: string;
  activeEmail?: string;
  lastActiveEmail?: string;
  lastManagedAccount?: string;
  managedAccount?: string;
};
type AccountChromeProfile = {
  id: string;
  name: string;
  outcome?: string;
  activeEmail?: string;
  lastActiveEmail?: string;
  lastManagedAccount?: string;
  lastSeenAt?: string;
  lastCheckedAt?: string;
};
type AccountSync = {
  error?: string;
  conflictingNames?: string[];
};

export const CODEX_MANAGER_AUTO_REFRESH_INTERVAL_MS = 5_000;

const tr = (locale: AppLocale, fa: string, en: string) =>
  locale === "fa" ? fa : en;
function formatDate(value: string | undefined, locale: AppLocale) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : undefined, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date)
    : "";
}
function planLabel(plan: string | undefined, locale: AppLocale) {
  return plan === "free"
    ? tr(locale, "رایگان", "Free")
    : plan === "plus"
      ? "Plus"
      : tr(locale, "نامشخص", "Unknown");
}
function stateLabel(state: string | undefined, locale: AppLocale) {
  if (state === "ready") return tr(locale, "آماده", "Ready");
  if (state === "needs_login") return tr(locale, "نیازمند ورود", "Needs login");
  if (state === "stale") return tr(locale, "قدیمی", "Stale");
  if (state === "error") return tr(locale, "خطا", "Error");
  return state || tr(locale, "نامشخص", "Unknown");
}
function durationLabel(seconds: number, locale: AppLocale) {
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (locale === "fa")
    return `${days ? `${days} روز ` : ""}${hours ? `${hours} ساعت ` : ""}${minutes} دقیقه`;
  return `${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${minutes}m`;
}
function compactDurationLabel(seconds: number, _locale: AppLocale) {
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  // Data tables need an unambiguous, fixed-width value.  Keep the short
  // duration notation independent of the page language so it never wraps.
  return days ? `${days}d ${hours}:${minutes}` : `${hours}:${minutes}`;
}
function resetLabel(window: QuotaWindow, locale: AppLocale, now: number) {
  if (window.resetAt) {
    const resetAt = new Date(window.resetAt).getTime();
    const remaining = Number.isFinite(resetAt)
      ? Math.max(0, Math.floor((resetAt - now) / 1000))
      : undefined;
    return `${tr(locale, "بازنشانی تا ", "Resets in ")}${remaining === undefined ? "—" : durationLabel(remaining, locale)} · ${formatDate(window.resetAt, locale)}`;
  }
  if (window.resetAfterSeconds !== undefined) {
    return `${tr(locale, "بازنشانی تا ", "Resets in ")}${durationLabel(window.resetAfterSeconds, locale)}`;
  }
  return "";
}
function codexQuotaLimit(account: Account) {
  return (account.rateLimits?.limits ?? []).find(
    (limit) => limit.id.trim().toLowerCase() === "codex",
  );
}

// The account table represents Codex availability, not an arbitrary auxiliary
// product limit. In particular, gpt-reserve can have a separate weekly meter
// even after the account's actual Codex weekly allowance is exhausted.
export function quotaWindowFor(
  account: Account,
  kind: "weekly" | "fiveHour",
): QuotaWindow | undefined {
  const matcher =
    kind === "weekly"
      ? /week|weekly|هفته/i
      : /(^|[^\d])5\s*(h|hour|ساعت)|five.?hour/i;
  return (codexQuotaLimit(account)?.windows ?? [])
    .find((window) => matcher.test(window.label));
}
function quotaPercent(window: QuotaWindow | undefined) {
  if (!window) return undefined;
  return Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
}
function quotaTone(window: QuotaWindow | undefined) {
  const percent = quotaPercent(window);
  if (window?.reached || percent === 0) return "text-destructive";
  if (percent === undefined) return "text-muted-foreground";
  if (percent <= 35) return "text-amber-600 dark:text-amber-300";
  return "text-emerald-600 dark:text-emerald-400";
}
function quotaListLabel(window: QuotaWindow | undefined, locale: AppLocale, now: number) {
  const percent = quotaPercent(window);
  if (percent === undefined) return "—";
  if (percent > 0 && !window?.reached) return `${Math.round(percent)}%`;
  let remaining: number | undefined;
  if (window?.resetAt) {
    const resetAt = new Date(window.resetAt).getTime();
    if (Number.isFinite(resetAt)) remaining = Math.max(0, Math.floor((resetAt - now) / 1000));
  } else if (window?.resetAfterSeconds !== undefined) {
    remaining = window.resetAfterSeconds;
  }
  return remaining === undefined
    ? `${Math.round(percent)}%`
    : `${Math.round(percent)}% · ${tr(locale, "تا ", "in ")}${compactDurationLabel(remaining, locale)}`;
}
function weeklyQuotaExhausted(window: QuotaWindow | undefined) {
  const remaining = quotaPercent(window)
  return Boolean(window?.reached || remaining === 0)
}
function fiveHourQuotaWindow(window: QuotaWindow) {
  return /5\s*(?:h|hour|ساعت)|five\s*hour/i.test(window.label)
}

// Extra limits are useful diagnostics while Codex is available. Once the
// actual Codex weekly allowance is exhausted they cannot make the account
// usable, so showing a green gpt-reserve bar is misleading. Keep only the
// decisive Codex weekly window in that state; when Codex is available every
// extra limit remains visible.
export function visibleQuotaLimits(account: Account) {
  const weeklyExhausted = weeklyQuotaExhausted(quotaWindowFor(account, "weekly"));
  return (account.rateLimits?.limits ?? [])
    .filter((limit) => !weeklyExhausted || limit.id.trim().toLowerCase() === "codex")
    .map((limit) => ({
      ...limit,
      windows: limit.windows.filter(
        (window) => !weeklyExhausted || !fiveHourQuotaWindow(window),
      ),
    }))
    .filter((limit) => limit.windows.length > 0);
}
function accountNeedsRelogin(account: Account, now: number) {
  if (account.state === "needs_login") return true;
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function chromeProfileState(profile: AccountChromeProfile | BrowserProfile | undefined, locale: AppLocale) {
  switch (profile?.outcome) {
    case "signed_in":
      return { label: tr(locale, "متصل", "Connected"), className: "text-emerald-600 dark:text-emerald-400" };
    case "partial":
      return { label: tr(locale, "ورود ناقص", "Partial sign-in"), className: "text-amber-600 dark:text-amber-300" };
    case "signed_out":
      return { label: tr(locale, "ورود تغییر کرده", "Sign-in changed"), className: "text-amber-600 dark:text-amber-300" };
    case "changed":
      return { label: tr(locale, "اکانت دیگری وارد است", "Different account signed in"), className: "text-amber-600 dark:text-amber-300" };
    case "error":
      return { label: tr(locale, "بررسی ناموفق", "Check failed"), className: "text-destructive" };
    case "missing":
      return { label: tr(locale, "پروفایل پیدا نشد", "Profile unavailable"), className: "text-destructive" };
    case "pending":
      return { label: tr(locale, "در حال بررسی", "Checking"), className: "text-muted-foreground" };
    default:
      return { label: tr(locale, "آخرین اتصال", "Last linked"), className: "text-muted-foreground" };
  }
}

function InfoHint({ locale, text }: { locale: AppLocale; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={tr(locale, "راهنما", "Help")}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        dir={locale === "fa" ? "rtl" : "ltr"}
        className="max-w-80 whitespace-normal text-start leading-relaxed"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function QuotaSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label="Loading quota">
      {[0, 1].map((index) => (
        <div
          key={index}
          className="rounded-lg border border-border/70 bg-background/30 p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="h-3 w-28 animate-pulse rounded bg-muted" />
            <span className="h-3 w-14 animate-pulse rounded bg-muted" />
          </div>
          <span className="mt-3 block h-1.5 w-full animate-pulse rounded-full bg-muted" />
          <span className="mt-3 block h-3 w-40 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function AccountsPanel({
  locale,
  onAdd,
  onRelogin,
  refreshKey = 0,
}: {
  locale: AppLocale;
  onAdd: () => void;
  onRelogin: (accountName: string) => void;
  refreshKey?: number;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingAccounts, setCheckingAccounts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(
    null,
  );
  const [recommendationResults, setRecommendationResults] = useState<
    Record<string, Recommendation>
  >({});
  const [profileForAccount, setProfileForAccount] = useState<
    Record<string, BrowserProfile>
  >({});
  const [openingProfile, setOpeningProfile] = useState<string | null>(null);
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const hasLoadedRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const initialLoad = !hasLoadedRef.current;
    if (initialLoad) setLoading(true);
    setRefreshing(true);
    const task = (async () => {
      setError(null);
      try {
        const response = await fetch("/api/codex-manager/accounts", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(await response.text());
        const payload = (await response.json()) as {
          accounts?: Account[];
          sync?: AccountSync;
        };
        setAccounts(payload.accounts ?? []);
        hasLoadedRef.current = true;
        if (payload.sync?.error) {
        const names = payload.sync.conflictingNames ?? [];
        setError(
          names.length > 0
            ? tr(
                locale,
                `اکانت فعال با رکوردهای «${names.join("»، «")}» تکراری است. یکی از آن‌ها را پس از بررسی حذف کنید؛ تغییر نام، تکراری بودن هویت را رفع نمی‌کند.`,
                `The active account is duplicated by ${names.join(", ")}. Review them and remove one; renaming does not resolve a duplicate identity.`,
              )
            : payload.sync.error,
        );
        }
        const [recommendationResponse, profilesResponse] = await Promise.all([
          fetch("/api/codex-manager/recommendation", { cache: "no-store" }),
          fetch("/api/codex-manager/browser/profiles", { cache: "no-store" }),
        ]);
        if (recommendationResponse.ok) {
          const recommendationPayload =
            (await recommendationResponse.json()) as RecommendationResponse;
          setRecommendation(
            recommendationPayload.best ?? recommendationPayload.Best ?? null,
          );
          setRecommendationResults(
            recommendationPayload.results ?? recommendationPayload.Results ?? {},
          );
        }
        if (profilesResponse.ok) {
          const profilePayload = (await profilesResponse.json()) as {
            profiles?: BrowserProfile[];
          };
          const nextProfiles: Record<string, BrowserProfile> = {};
          for (const profile of profilePayload.profiles ?? []) {
            if (profile.managedAccount)
              nextProfiles[profile.managedAccount] ??= profile;
            for (const accountName of Object.values(profile.accounts ?? {}))
              nextProfiles[accountName] ??= profile;
          }
          setProfileForAccount(nextProfiles);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRefreshing(false);
        if (initialLoad) setLoading(false);
      }
    })();
    refreshInFlightRef.current = task;
    void task.finally(() => {
      if (refreshInFlightRef.current === task) {
        refreshInFlightRef.current = null;
      }
    });
    return task;
  }, [locale]);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), CODEX_MANAGER_AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error(await response.text());
  }
  async function activate(name: string) {
    setActionPending(true);
    setError(null);
    try {
      await request(
        `/api/codex-manager/accounts/${encodeURIComponent(name)}/activate`,
        { method: "POST" },
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }
  async function activateBest() {
    setActionPending(true);
    setError(null);
    try {
      await request("/api/codex-manager/recommendation", { method: "POST" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }
  async function refreshAccount(account: Account, forceRefresh = false) {
    setCheckingAccounts((current) => new Set(current).add(account.name));
    setError(null);
    try {
      await request(
        `/api/codex-manager/accounts/${encodeURIComponent(account.name)}/check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceRefresh }),
        },
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCheckingAccounts((current) => {
        const next = new Set(current);
        next.delete(account.name);
        return next;
      });
    }
  }
  async function setSessionMonitor(account: Account, disabled: boolean) {
    setActionPending(true);
    setError(null);
    try {
      await request(
        `/api/codex-manager/accounts/${encodeURIComponent(account.name)}/session-monitor`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled }),
        },
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }
  async function rename(account: Account) {
    const next = window
      .prompt(tr(locale, "نام جدید حساب:", "New account name:"), account.name)
      ?.trim();
    if (!next || next === account.name) return;
    setActionPending(true);
    setError(null);
    try {
      await request(
        `/api/codex-manager/accounts/${encodeURIComponent(account.name)}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: next }),
        },
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }
  async function remove(account: Account) {
    if (
      !window.confirm(
        tr(
          locale,
          `حساب «${account.name}» حذف شود؟ این کار قابل برگشت نیست.`,
          `Delete “${account.name}”? This cannot be undone.`,
        ),
      )
    )
      return;
    setActionPending(true);
    setError(null);
    try {
      await request(
        `/api/codex-manager/accounts/${encodeURIComponent(account.name)}/delete`,
        { method: "DELETE" },
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }
  async function checkNow() {
    setCheckingAll(true);
    setError(null);
    try {
      await request("/api/codex-manager/check", { method: "POST" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCheckingAll(false);
    }
  }
  async function openProfile(profile: BrowserProfile) {
    setOpeningProfile(profile.id);
    setError(null);
    try {
      await request(
        `/api/codex-manager/browser/profiles/open?profileId=${encodeURIComponent(profile.id)}`,
        { method: "POST" },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningProfile(null);
    }
  }
  const busy = loading || actionPending;
  const orderedAccounts = [...accounts].sort((left, right) => {
    // Match codex-manager's TUI ordering: paid/unknown plans first, then the
    // recommendation score, then a stable name ordering. A missing sample
    // deliberately stays below accounts with a useful fresh recommendation.
    const leftFree = left.plan === "free";
    const rightFree = right.plan === "free";
    if (leftFree !== rightFree) return leftFree ? 1 : -1;
    const leftScore = recommendationResults[left.name]?.score ?? -Infinity;
    const rightScore = recommendationResults[right.name]?.score ?? -Infinity;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  return (
    <section
      className="grid gap-3 rounded-xl border border-border bg-card/30 p-4"
      dir={locale === "fa" ? "rtl" : "ltr"}
      aria-labelledby="codex-manager-accounts-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3
              id="codex-manager-accounts-title"
              className="text-sm font-semibold"
            >
              {tr(locale, "حساب‌های Codex Manager", "Codex Manager accounts")}
            </h3>
            <InfoHint
              locale={locale}
              text={tr(
                locale,
                "برای دیدن جزئیات، انتخاب حساب فعال یا باز کردن پروفایل Chrome، روی ردیف حساب بزنید.",
                "Select an account row to see details, choose it as active, or open its Chrome profile.",
              )}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={onAdd} disabled={busy}>
            <UserPlus className="size-3.5" />
            {tr(locale, "افزودن حساب", "Add account")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={busy}
            aria-label={tr(
              locale,
              "به‌روزرسانی فهرست حساب‌ها",
              "Refresh account list",
            )}
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void checkNow()}
            disabled={busy || checkingAll}
          >
            {checkingAll ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {tr(locale, "بررسی سهمیه", "Check limits")}
          </Button>
        </div>
      </div>
      {loading || checkingAll ? (
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-3 animate-spin" />
          {checkingAll
            ? tr(
                locale,
                "در حال بررسی/refresh حساب‌ها…",
                "Checking and refreshing accounts…",
              )
            : tr(
                locale,
                "در حال دریافت حساب‌ها از Manager API…",
                "Loading accounts from Manager API…",
              )}
        </p>
      ) : null}
      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="break-words">{error}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            {tr(locale, "تلاش دوباره", "Retry")}
          </Button>
        </div>
      ) : null}
      {recommendation?.account ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
          <span>
            <span className="font-medium">
              {tr(locale, "پیشنهاد بهترین حساب: ", "Recommended account: ")}
              {recommendation.account}
            </span>
            {recommendation.reason ? (
              <span className="text-muted-foreground">
                {" "}
                · {recommendation.reason}
              </span>
            ) : null}
            {recommendation.remaining !== undefined ? (
              <span className="text-muted-foreground">
                {" "}
                · {tr(locale, "باقی: ", "Remaining: ")}
                {Math.round(recommendation.remaining)}%
                {recommendation.target !== undefined
                  ? ` / ${tr(locale, "هدف ", "target ")}${Math.round(recommendation.target)}%`
                  : ""}
              </span>
            ) : null}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void activateBest()}
            disabled={busy || !recommendation.recommendable}
          >
            <Sparkles className="size-3.5" />
            {tr(locale, "فعال‌سازی بهترین", "Activate best")}
          </Button>
        </div>
      ) : null}
      {accounts.length === 0 && !loading ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          <UserPlus className="mx-auto mb-2 size-5" />
          {tr(
            locale,
            "هنوز حسابی اضافه نشده است؛ برای شروع «افزودن حساب» را بزنید.",
            "No accounts yet. Select “Add account” to get started.",
          )}
        </div>
      ) : null}
      {loading && accounts.length === 0 ? (
        <div
          className="overflow-hidden rounded-xl border border-border/80"
          aria-label={tr(locale, "در حال دریافت فهرست حساب‌ها", "Loading account list")}
          aria-busy="true"
        >
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_5rem] items-center gap-4 border-b border-border/60 px-4 py-4 last:border-b-0"
            >
              <span className="h-4 w-28 animate-pulse rounded bg-muted" />
              <span className="h-3 w-40 animate-pulse rounded bg-muted" />
              <span className="h-4 w-12 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : null}
      {accounts.length > 0 ? (
        <div
          className="overflow-hidden rounded-xl border border-border/80 bg-background/20"
          role="table"
          aria-label={tr(locale, "فهرست حساب‌های Codex", "Codex account list")}
        >
          <div
            className="hidden grid-cols-[minmax(8rem,1.1fr)_minmax(12rem,1.5fr)_minmax(8.5rem,1fr)_minmax(8.5rem,1fr)_minmax(8rem,1fr)_1.5rem] gap-3 border-b border-border/70 bg-muted/35 px-4 py-1.5 text-[11px] font-medium text-muted-foreground lg:grid"
            role="row"
          >
            <span role="columnheader">{tr(locale, "نام", "Name")}</span>
            <span role="columnheader">{tr(locale, "ایمیل", "Email")}</span>
            <span role="columnheader">{tr(locale, "سهمیهٔ هفتگی", "Weekly")}</span>
            <span role="columnheader">{tr(locale, "سهمیهٔ ۵ ساعته", "5-hour")}</span>
            <span role="columnheader">{tr(locale, "پروفایل Chrome", "Chrome profile")}</span>
            <span aria-hidden="true" />
          </div>
          <div role="rowgroup">
            {orderedAccounts.map((account) => {
              const weekly = quotaWindowFor(account, "weekly");
              const fiveHour = quotaWindowFor(account, "fiveHour");
              const hideFiveHour = weeklyQuotaExhausted(weekly);
              const visibleLimits = visibleQuotaLimits(account);
              const quotaChecking = checkingAll || checkingAccounts.has(account.name);
              const scannedProfile = profileForAccount[account.name];
              const profile = account.chromeProfile ?? scannedProfile;
              const profileState = chromeProfileState(profile, locale);
              const expanded = expandedAccount === account.name;
              const needsRelogin = accountNeedsRelogin(account, now);
			  const displayStatusMessage = account.state === "ready" ? "" : account.statusMessage;
              const detailsID = `codex-account-${account.name}-details`;
              const accountStateClass =
                account.state === "ready"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : account.state === "error" || account.state === "needs_login"
                    ? "text-destructive"
                    : "text-amber-600 dark:text-amber-300";
              return (
                <div key={account.name} role="row" className="border-b border-border/60 last:border-b-0">
                  <button
                    type="button"
                    className="grid w-full grid-cols-[minmax(0,1fr)_1.5rem] gap-x-3 gap-y-1 px-4 py-2 text-right transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:grid-cols-[minmax(8rem,1.1fr)_minmax(12rem,1.5fr)_minmax(8.5rem,1fr)_minmax(8.5rem,1fr)_minmax(8rem,1fr)_1.5rem] lg:items-center"
                    onClick={() =>
                      setExpandedAccount((current) =>
                        current === account.name ? null : account.name,
                      )
                    }
                    aria-expanded={expanded}
                    aria-controls={detailsID}
                  >
                    <span className="min-w-0" role="cell">
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="truncate text-sm font-semibold">{account.name}</span>
                        {account.active ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                            <ShieldCheck className="size-3" />
                            {tr(locale, "فعال", "Active")}
                          </span>
                        ) : null}
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {planLabel(account.plan, locale)}
                        </span>
						<span className={`rounded-full px-1.5 py-0.5 text-[10px] ${needsRelogin ? "bg-destructive/15 font-semibold text-destructive" : accountStateClass}`} title={displayStatusMessage || undefined}>
                          {needsRelogin ? tr(locale, "ورود دوباره لازم است", "Re-login required") : stateLabel(account.state, locale)}
                        </span>
                      </span>
                    </span>
                    <span className="min-w-0 text-xs text-muted-foreground lg:contents" role="cell">
                      <span className="mt-1 block truncate lg:mt-0" dir="ltr" title={account.email}>
                        {account.email || tr(locale, "ایمیل ثبت نشده", "Email unavailable")}
                      </span>
                    </span>
                    <span className={`hidden whitespace-nowrap text-sm font-semibold tabular-nums lg:block ${quotaTone(weekly)}`} role="cell">
                      {quotaChecking ? <span className="inline-block h-4 w-12 animate-pulse rounded bg-muted" aria-label={tr(locale, "در حال بررسی سهمیه", "Checking quota")} /> : quotaListLabel(weekly, locale, now)}
                    </span>
                    <span className={`hidden whitespace-nowrap text-sm font-semibold tabular-nums lg:block ${hideFiveHour ? "text-muted-foreground" : quotaTone(fiveHour)}`} role="cell">
                      {quotaChecking ? <span className="inline-block h-4 w-12 animate-pulse rounded bg-muted" aria-label={tr(locale, "در حال بررسی سهمیه", "Checking quota")} /> : hideFiveHour ? "—" : quotaListLabel(fiveHour, locale, now)}
                    </span>
                    <span className={`hidden min-w-0 items-center gap-1 text-xs lg:flex ${profileState.className}`} role="cell" title={profile ? `${profile.name} · ${profileState.label}` : undefined}>
                      {profile ? <CircleAlert className="size-3 shrink-0" aria-hidden="true" /> : null}
                      <span className="truncate">{profile?.name || "—"}</span>
                      {profile ? <span className="truncate text-[10px]">{profileState.label}</span> : null}
                    </span>
                    <span className="flex justify-end self-center" aria-hidden="true">
                      {expanded ? <ChevronDown className="size-4" /> : <ChevronLeft className="size-4 rtl:-scale-x-100" />}
                    </span>
                  </button>
                  {expanded ? (
                    <div id={detailsID} className="grid gap-4 border-t border-border/60 bg-muted/15 px-4 py-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,1fr)]">
                      <div className="grid gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <h4 className="text-sm font-semibold">{tr(locale, "جزئیات حساب", "Account details")}</h4>
                            <InfoHint locale={locale} text={tr(locale, "اطلاعات کامل، زمان بازنشانی و عملیات همین حساب در این بخش قرار دارد.", "This section contains the account details, reset times, and actions.")} />
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <Button size="sm" variant="outline" onClick={() => void refreshAccount(account)} disabled={busy || quotaChecking}>
                              {quotaChecking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                              {tr(locale, "بررسی سهمیه", "Check limits")}
                            </Button>
                            {!account.active ? (
                              <Button size="sm" onClick={() => void activate(account.name)} disabled={busy}>
                                {tr(locale, "فعال‌سازی", "Activate")}
                              </Button>
                            ) : null}
                            {needsRelogin ? (
                              <Button size="sm" variant="destructive" onClick={() => onRelogin(account.name)} disabled={busy}>
                                <LogIn className="size-3.5" />
                                {tr(locale, "ورود دوباره", "Re-login")}
                              </Button>
                            ) : null}
                            <Button size="icon-sm" variant="ghost" onClick={() => void rename(account)} disabled={busy} aria-label={tr(locale, "تغییر نام حساب", "Rename account")}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => void remove(account)} disabled={busy || account.active} aria-label={tr(locale, "حذف حساب", "Delete account")}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                        <div className="grid gap-2 rounded-lg border border-border/70 bg-background/30 p-3 text-xs">
                          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]"><span className="text-muted-foreground">{tr(locale, "ایمیل", "Email")}</span><span className="break-all" dir="ltr">{account.email || "—"}</span></div>
                          {account.accountId ? <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]"><span className="text-muted-foreground">{tr(locale, "شناسهٔ حساب", "Account ID")}</span><span className="break-all font-mono text-[11px]" dir="ltr">{account.accountId}</span></div> : null}
                          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]"><span className="text-muted-foreground">{tr(locale, "آخرین بررسی", "Last checked")}</span><span>{account.lastCheckedAt ? formatDate(account.lastCheckedAt, locale) : tr(locale, "هنوز بررسی نشده", "Not checked yet")}</span></div>
                          {account.lastRefreshAt ? <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]"><span className="text-muted-foreground">{tr(locale, "آخرین نوسازی ورود", "Last sign-in refresh")}</span><span>{formatDate(account.lastRefreshAt, locale)}</span></div> : null}
                          {account.tokenExpiresAt ? <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]"><span className="text-muted-foreground">{tr(locale, "انقضای ورود", "Sign-in expiry")}</span><span>{formatDate(account.tokenExpiresAt, locale)}</span></div> : null}
                        </div>
                        {profile ? (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/30 p-3 text-xs">
                            <span className="min-w-0">
                              <span className="text-muted-foreground">{tr(locale, "پروفایل Chrome در آخرین مشاهده: ", "Chrome profile at last observation: ")}</span>
                              {profile.name}
                              <span className={`ms-1.5 ${profileState.className}`}>· {profileState.label}</span>
                              {profile.activeEmail ? <span className="ms-1 text-muted-foreground" dir="ltr">({profile.activeEmail})</span> : null}
                            </span>
                            <span className="w-full text-muted-foreground">
                              {profile.activeEmail
                                ? `${tr(locale, "ورود فعلی ChatGPT: ", "Current ChatGPT sign-in: ")}${profile.activeEmail}`
                                : tr(locale, "در حال حاضر ورود ChatGPT تأیید نشده است.", "No current ChatGPT sign-in is confirmed.")}
                              {profile.lastActiveEmail ? <span className="ms-2" dir="ltr">· {tr(locale, "آخرین حساب این Chrome: ", "Last account in this Chrome: ")}{profile.lastActiveEmail}{profile.lastManagedAccount ? ` (${profile.lastManagedAccount})` : ""}</span> : null}
                            </span>
                            <Button size="sm" variant="outline" onClick={() => void openProfile(profile)} disabled={busy || openingProfile === profile.id || profile.outcome === "missing"}>
                              {openingProfile === profile.id ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
                              {tr(locale, "باز کردن Chrome", "Open Chrome")}
                            </Button>
                          </div>
                        ) : <p className="text-xs text-muted-foreground">{tr(locale, "پروفایل Chrome مرتبطی برای این حساب پیدا نشده است.", "No matching Chrome profile was found for this account.")}</p>}
                        <div className="grid gap-1 rounded-lg border border-border/70 bg-background/30 p-3 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 font-medium">
                              {tr(locale, "پایش نشست‌های Codex", "Codex session monitor")}
                              <InfoHint locale={locale} text={tr(locale, "تعداد نشست‌های Codex و سابقهٔ خروج، همیشه نگه‌داری می‌شود. کلید زیر فقط خروج خودکار نشست‌های اضافه را برای همین حساب روشن یا خاموش می‌کند.", "Codex session counts and revoke history are always retained. The switch below only enables or disables automatic cleanup for this account.")} />
                            </span>
                            <span className="text-muted-foreground">
                              {account.sessionMonitor?.lastCheckedAt
                                ? formatDate(account.sessionMonitor.lastCheckedAt, locale)
                                : tr(locale, "هنوز بررسی نشده", "Not checked yet")}
                            </span>
                          </div>
                          <p className="leading-relaxed text-muted-foreground">
                            {tr(locale, "نشست‌های Codex: ", "Codex sessions: ")}{account.sessionMonitor?.codexSessions ?? 0}
                            {" · "}{tr(locale, "نشست اضافه: ", "Extra sessions: ")}{account.sessionMonitor?.excessCodexSessions ?? 0}
                            {" · "}{tr(locale, "خروج این نوبت: ", "Revoked this run: ")}{account.sessionMonitor?.revokedLastRun ?? 0}
                            {" · "}{tr(locale, "خروج کل: ", "Total revoked: ")}{account.sessionMonitor?.revokedTotal ?? 0}
                            {account.sessionMonitor?.currentDeviceProtected ? ` · ${tr(locale, "دستگاه فعلی محافظت شد", "Current device protected")}` : ""}
                          </p>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={!account.sessionMonitor?.revocationDisabled}
                            onClick={() => void setSessionMonitor(account, !account.sessionMonitor?.revocationDisabled)}
                            disabled={busy}
                            className={`flex h-8 w-full items-center justify-between gap-3 rounded-md border px-2.5 text-xs transition-colors ${account.sessionMonitor?.revocationDisabled ? "border-border bg-background text-muted-foreground hover:bg-muted/50" : "border-emerald-500/35 bg-emerald-500/10 text-foreground"}`}
                          >
                            <span>{tr(locale, "خروج خودکار نشست‌های اضافهٔ این حساب", "Auto-revoke this account's extra sessions")}</span>
                            <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full ${account.sessionMonitor?.revocationDisabled ? "bg-muted-foreground/30" : "bg-emerald-500"}`}>
                              <span className={`absolute size-3 rounded-full bg-background shadow-sm transition-transform ${account.sessionMonitor?.revocationDisabled ? "translate-x-0.5 rtl:-translate-x-0.5" : "translate-x-3.5 rtl:-translate-x-3.5"}`} />
                            </span>
                          </button>
                          {account.sessionMonitor?.checkHistory?.length ? <div className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                            <span className="font-medium text-foreground">{tr(locale, "سه بررسی آخر", "Last checks")}</span>
                            <ul className="mt-1 grid gap-1">
                              {account.sessionMonitor.checkHistory.slice(0, 3).map((check, index) => <li key={`${check.checkedAt ?? "unknown"}-${index}`}>
                                {check.checkedAt ? formatDate(check.checkedAt, locale) : "—"} · {tr(locale, "نشست", "sessions")} {check.codexSessions ?? "—"} · {tr(locale, "خروج", "revoked")} {check.revokedLastRun ?? 0}
                                {check.error ? ` · ${check.error}` : ""}
                              </li>)}
                            </ul>
                          </div> : null}
                          {account.sessionMonitor?.error ? <p className="text-destructive">{account.sessionMonitor.error}</p> : null}
                        </div>
                      </div>
                      <div className="grid content-start gap-3">
                        <div className="flex items-center gap-1.5">
                          <h4 className="text-sm font-semibold">{tr(locale, "سهمیه و زمان بازنشانی", "Quota and reset times")}</h4>
                          <InfoHint locale={locale} text={tr(locale, "درصدها مقدار باقی‌مانده‌اند؛ زمان زیر هر نوار، زمان تقریبی آزاد شدن دوبارهٔ سهمیه است.", "Percentages show what remains. The time below a bar estimates when that allowance becomes available again.")} />
                        </div>
                        {quotaChecking ? <QuotaSkeleton /> : visibleLimits.length > 0 ? visibleLimits.flatMap((limit) => limit.windows
                          .map((window) => {
                          const value = quotaPercent(window) ?? 0;
                          return <div key={`${limit.id}-${window.label}`} className="rounded-lg border border-border/70 bg-background/30 p-3">
                            <div className="flex items-center justify-between gap-3 text-xs"><span dir="ltr">{limit.name || limit.id} · {window.label}</span><span className={`font-semibold tabular-nums ${quotaTone(window)}`}>{Math.round(value)}% {tr(locale, "باقی", "remaining")}</span></div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={window.reached || value === 0 ? "h-full rounded-full bg-destructive" : value <= 35 ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-emerald-500"} style={{ width: `${value}%` }} /></div>
                            {resetLabel(window, locale, now) ? <p className="mt-2 text-[11px] text-muted-foreground">{resetLabel(window, locale, now)}</p> : null}
                          </div>;
                        })) : <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">{tr(locale, "هنوز سهمیه‌ای برای این حساب ثبت نشده است. «بررسی سهمیه» را بزنید تا مقدارها نمایش داده شوند.", "No quota has been recorded for this account yet. Select “Check limits” to load it.")}</p>}
                        {account.rateLimits?.reachedType ? <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{tr(locale, "یکی از سهمیه‌های این حساب فعلاً تمام شده است.", "One of this account’s allowances is currently exhausted.")}</p> : null}
                        {account.rateLimits?.error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{tr(locale, "بررسی سهمیهٔ این حساب ناموفق بود: ", "This account’s quota check failed: ")}{account.rateLimits.error}</p> : null}
						{displayStatusMessage ? <p className="rounded-lg border border-border/70 bg-background/30 px-3 py-2 text-xs text-muted-foreground">{displayStatusMessage}</p> : null}
                        <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => onRelogin(account.name)} disabled={busy}>{tr(locale, "نوسازی اجباری ورود", "Force sign-in refresh")}</Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
