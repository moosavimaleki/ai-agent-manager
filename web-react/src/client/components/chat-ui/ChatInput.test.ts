import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { I18nProvider } from "../../i18n/context"
import { ChatInput, createPastedTextFile, getClipboardImageFiles, isUsableUploadedAttachment, PASTED_TEXT_FILE_THRESHOLD, shouldApplyCodexExecutionModeToRuntime, trimTrailingPastedNewlines, willExceedAttachmentLimit } from "./ChatInput"

function createClipboardItem(args: {
  kind?: string
  type: string
  file?: File | null
}) {
  return {
    kind: args.kind ?? "file",
    type: args.type,
    getAsFile: () => args.file ?? null,
  }
}

describe("willExceedAttachmentLimit", () => {
  test("rejects a batch that would push the composer above the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 3,
    })).toBe(true)
  })

  test("allows a batch that exactly reaches the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 2,
    })).toBe(false)
  })

  test("counts pasted files against the same total attachment limit", () => {
    const pastedFiles = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/png", file: new File(["b"], "", { type: "image/png" }) }),
    ], 123)

    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 48,
      queuedAttachmentCount: 0,
      incomingAttachmentCount: pastedFiles.length,
    })).toBe(false)
  })
})

describe("shouldApplyCodexExecutionModeToRuntime", () => {
  test("changes the live app-server session only while this server owns it", () => {
    expect(shouldApplyCodexExecutionModeToRuntime(true, "codex", "owned_by_us")).toBe(true)
    expect(shouldApplyCodexExecutionModeToRuntime(true, "codex", "owned_elsewhere")).toBe(false)
    expect(shouldApplyCodexExecutionModeToRuntime(true, "codex", "available")).toBe(false)
    expect(shouldApplyCodexExecutionModeToRuntime(true, "codex", "unknown")).toBe(false)
  })

  test("stages the mode for new chats and non-Codex providers", () => {
    expect(shouldApplyCodexExecutionModeToRuntime(false, "codex", undefined)).toBe(false)
    expect(shouldApplyCodexExecutionModeToRuntime(true, "claude", "owned_by_us")).toBe(false)
  })
})

describe("getClipboardImageFiles", () => {
  test("returns image files from clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "pasted.png", { type: "image/png" }) }),
    ], 123)

    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe("pasted.png")
  })

  test("ignores non-image clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ kind: "string", type: "text/plain" }),
      createClipboardItem({ type: "application/pdf", file: new File(["pdf"], "doc.pdf", { type: "application/pdf" }) }),
    ], 123)

    expect(files).toEqual([])
  })

  test("renames unnamed pasted images using the clipboard timestamp", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("preserves existing filenames from the browser", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/jpeg", file: new File(["img"], "Screenshot 1.jpg", { type: "image/jpeg" }) }),
    ], 456)

    expect(files[0]?.name).toBe("Screenshot 1.jpg")
  })

  test("rewrites generic browser clipboard filenames", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "image.png", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("generates distinct names for multiple unnamed images in one paste event", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/webp", file: new File(["b"], "", { type: "image/webp" }) }),
    ], 789)

    expect(files.map((file) => file.name)).toEqual([
      "clipboard-789.png",
      "clipboard-789-1.webp",
    ])
  })
})

describe("createPastedTextFile", () => {
  test("matches Codex Mobile long-paste threshold and attachment filename", async () => {
    expect(PASTED_TEXT_FILE_THRESHOLD).toBe(2000)
    const file = createPastedTextFile("long text", new Date(2026, 7, 24, 15, 8, 37))
    expect(file.name).toBe("pasted-text-2026-08-24-15-08-37.txt")
    expect(file.type.startsWith("text/plain")).toBe(true)
    expect(await file.text()).toBe("long text")
  })
})

describe("isUsableUploadedAttachment", () => {
  test("rejects incomplete image metadata returned by the upload API", () => {
    expect(isUsableUploadedAttachment({ id: "img", kind: "image", displayName: "image.png", absolutePath: "/tmp/image.png", relativePath: "", contentUrl: "/api/image", mimeType: "image/png", size: 0 })).toBe(false)
  })

  test("accepts a non-empty image and text attachments", () => {
    expect(isUsableUploadedAttachment({ id: "img", kind: "image", displayName: "image.png", absolutePath: "/tmp/image.png", relativePath: "", contentUrl: "/api/image", mimeType: "image/png", size: 12 })).toBe(true)
    expect(isUsableUploadedAttachment({ id: "txt", kind: "file", displayName: "empty.txt", absolutePath: "/tmp/empty.txt", relativePath: "", contentUrl: "/api/text", mimeType: "text/plain", size: 0 })).toBe(true)
  })
})

describe("trimTrailingPastedNewlines", () => {
  test("removes trailing unix newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\n\n")).toBe("hello")
  })

  test("removes trailing windows newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\r\n\r\n")).toBe("hello")
  })

  test("preserves internal newlines", () => {
    expect(trimTrailingPastedNewlines("hello\nworld\n")).toBe("hello\nworld")
  })

  test("leaves text without trailing newlines unchanged", () => {
    expect(trimTrailingPastedNewlines("hello")).toBe("hello")
  })
})

describe("ChatInput", () => {
  test("keeps authoritative app-server activity visible beside the composer", () => {
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      { locale: "fa" },
      createElement(ChatInput, {
        onSubmit: async () => undefined,
        disabled: false,
        connectionStatus: "connected",
        runtimeStatus: "running",
        processingStatus: "running_command",
        turnStartedAt: Date.now() - 5_000,
        canCancel: true,
        activeProvider: "codex",
        availableProviders: PROVIDERS,
      })
    ))

    expect(html).toContain("Codex app-server")
    expect(html).toContain("در حال اجرای دستور")
    expect(html).toContain('role="status"')
  })

  test("keeps the draft editable but disables submission while disconnected", () => {
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      { locale: "fa" },
      createElement(ChatInput, {
        onSubmit: async () => undefined,
        disabled: false,
        connectionStatus: "disconnected",
        canCancel: false,
        activeProvider: null,
        availableProviders: PROVIDERS,
      })
    ))

    expect(html).toContain("ارتباط قطع است؛ در حال اتصال مجدد…")
    expect(html).toContain('placeholder="ارتباط قطع است؛ پیام شما در پیش‌نویس می‌ماند."')
    expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain(' disabled=""')
    expect(html).toContain('aria-label="ارتباط قطع است؛ در حال اتصال مجدد…"')
  })

  test("renders the mobile attachment trigger as a native file input target", () => {
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      { locale: "en" },
      createElement(ChatInput, {
        onSubmit: async () => undefined,
        disabled: false,
        canCancel: false,
        activeProvider: null,
        availableProviders: PROVIDERS,
      })
    ))

    expect(html).toContain('aria-label="Add attachment"')
    expect(html).toContain('type="file"')
    expect(html).toContain("absolute inset-0 cursor-pointer opacity-0")
    expect(html).not.toContain('type="file" multiple="" class="hidden"')
  })

  test("keeps the composer visible and replaces send with takeover while another Codex owns the session", () => {
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      { locale: "en" },
      createElement(ChatInput, {
        onSubmit: async () => undefined,
        disabled: false,
        readOnly: true,
        canCancel: false,
        activeProvider: "codex",
        availableProviders: PROVIDERS,
        codexLock: {
          state: "owned_elsewhere",
          canTakeOver: true,
          canRelease: false,
          ownerPid: 123,
        },
        onTakeOverSession: () => undefined,
        onRefreshSessionLock: () => undefined,
      })
    ))

    expect(html).toContain('placeholder="This session is open in another Codex process; you cannot send messages here."')
    expect(html).toContain('textarea')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-label="Take over session"')
    expect(html).toContain('title="Take over session"')
    expect(html).toContain('aria-label="Refresh session text"')
    expect(html).toContain('title="Refresh session text"')
    expect(html).not.toContain(">Locked by another Codex<")
    expect(html).not.toContain("bg-amber")
    expect(html).not.toContain("text-amber")
  })

  test("explains the read-only lock state in Persian instead of showing the normal composer prompt", () => {
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      { locale: "fa" },
      createElement(ChatInput, {
        onSubmit: async () => undefined,
        disabled: false,
        readOnly: true,
        canCancel: false,
        activeProvider: "codex",
        availableProviders: PROVIDERS,
        codexLock: {
          state: "owned_elsewhere",
          canTakeOver: true,
          canRelease: false,
          ownerPid: 123,
        },
        onTakeOverSession: () => undefined,
      })
    ))

    expect(html).toContain('placeholder="این نشست در Codex دیگری باز است؛ از اینجا نمی‌توانید پیام ارسال کنید."')
    expect(html).not.toContain('placeholder="یک پیام بنویسید..."')
  })

  test("renders a compact releasable lock control beside model preferences when we own the session", () => {
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      { locale: "en" },
      createElement(ChatInput, {
        onSubmit: async () => undefined,
        disabled: false,
        canCancel: false,
        activeProvider: "codex",
        availableProviders: PROVIDERS,
        codexLock: {
          state: "owned_by_us",
          canTakeOver: false,
          canRelease: true,
        },
        onReleaseSession: () => undefined,
      })
    ))

    expect(html).not.toContain(">Locked by us<")
    expect(html).toContain('title="Release session"')
    expect(html).toContain('aria-label="Release session"')
    expect(html).not.toContain("This session is owned by Abolqasem")
    expect(html).not.toContain("text-emerald")
  })

  test("shows a compact Codex account reload action only for a session owned by this server", () => {
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      { locale: "en" },
      createElement(ChatInput, {
        onSubmit: async () => undefined,
        disabled: false,
        canCancel: false,
        activeProvider: "codex",
        availableProviders: PROVIDERS,
        codexLock: {
          state: "owned_by_us",
          canTakeOver: false,
          canRelease: true,
        },
        onReloadCodexAuth: () => undefined,
      })
    ))

    expect(html).toContain('title="Reload Codex account"')
    expect(html).toContain('aria-label="Reload Codex account"')
  })
})
