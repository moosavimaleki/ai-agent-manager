import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { replaceGlobalProperty, restoreGlobalProperties } from "../test/globalProperty"
import { AbolqasemSocket } from "./socket"

type EventHandler = (event?: unknown) => void

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventHandler>>()

  addEventListener(type: string, listener: EventHandler) {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(listener)
  }

  removeEventListener(type: string, listener: EventHandler) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

class FakeTimers {
  private nextId = 1
  readonly timeouts = new Map<number, () => void>()
  readonly intervals = new Map<number, () => void>()

  setTimeout = (callback: () => void) => {
    const id = this.nextId++
    this.timeouts.set(id, callback)
    return id
  }

  clearTimeout = (id: number) => {
    this.timeouts.delete(id)
  }

  setInterval = (callback: () => void) => {
    const id = this.nextId++
    this.intervals.set(id, callback)
    return id
  }

  clearInterval = (id: number) => {
    this.intervals.delete(id)
  }

  runTimeout(id: number) {
    const callback = this.timeouts.get(id)
    if (!callback) return
    this.timeouts.delete(id)
    callback()
  }

  runInterval(id: number) {
    this.intervals.get(id)?.()
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Set<EventHandler>>()
  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventHandler) {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(listener)
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit("open")
  }

  receive(message: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(message) })
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit("close")
  }

  private emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

class FakeMessagePort extends FakeEventTarget {
  readonly sent: unknown[] = []
  closed = false

  start() {}

  postMessage(message: unknown) {
    this.sent.push(message)
  }

  close() {
    this.closed = true
  }
}

class FakeSharedWorker {
  static instances: FakeSharedWorker[] = []

  readonly port = new FakeMessagePort()

  constructor(
    readonly url: URL,
    readonly options?: string | WorkerOptions
  ) {
    FakeSharedWorker.instances.push(this)
  }

  addEventListener() {}
}

describe("AbolqasemSocket", () => {
  let windowTarget: FakeEventTarget
  let documentTarget: FakeEventTarget & { visibilityState: "visible" | "hidden" }
  let timers: FakeTimers
  let restoreGlobals: Array<() => void> = []

  beforeEach(() => {
    FakeWebSocket.instances = []
    timers = new FakeTimers()
    windowTarget = new FakeEventTarget()
    documentTarget = Object.assign(new FakeEventTarget(), { visibilityState: "visible" as const })

    restoreGlobals = [
      replaceGlobalProperty("window", Object.assign(windowTarget, {
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        location: { protocol: "http:", host: "localhost:3211" },
        sessionStorage: { getItem: () => null },
        localStorage: { getItem: () => null },
      })),
      replaceGlobalProperty("document", documentTarget),
      replaceGlobalProperty("WebSocket", FakeWebSocket),
    ]
  })

  afterEach(() => {
    restoreGlobalProperties(restoreGlobals)
    restoreGlobals = []
  })

  test("does not ping when the connection is already fresh", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    await socket.ensureHealthyConnection()

    expect(ws.sent).toHaveLength(0)
    socket.dispose()
  })

  test("abandons a WebSocket that stays connecting instead of waiting for the browser timeout", () => {
    const statuses: string[] = []
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.onStatus((status) => statuses.push(status))
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    const connectTimeoutId = (socket as any).connectTimeoutTimer as number

    timers.runTimeout(connectTimeoutId)

    expect(firstWs.readyState).toBe(FakeWebSocket.CLOSED)
    expect(statuses.at(-1)).toBe("disconnected")
    const reconnectTimerId = (socket as any).reconnectTimer as number
    timers.runTimeout(reconnectTimerId)
    expect(FakeWebSocket.instances).toHaveLength(2)
    socket.dispose()
  })

  test("uses an anonymous SharedWorker so a deploy cannot reuse the previous named worker", () => {
    FakeSharedWorker.instances = []
    restoreGlobals.push(replaceGlobalProperty("SharedWorker", FakeSharedWorker))
    const socket = new AbolqasemSocket("ws://localhost/ws")

    socket.start()

    const worker = FakeSharedWorker.instances[0]!
    expect(worker.options).toEqual({ type: "module" })
    expect(typeof worker.options === "object" && worker.options?.name).toBeUndefined()
    expect(worker.port.sent[0]).toEqual({ type: "start", url: "ws://localhost/ws" })
    socket.dispose()
    expect(worker.port.closed).toBe(true)
  })

  test("falls back to a direct socket when a SharedWorker does not connect promptly", () => {
    FakeSharedWorker.instances = []
    restoreGlobals.push(replaceGlobalProperty("SharedWorker", FakeSharedWorker))
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const worker = FakeSharedWorker.instances[0]!
    const workerTimeoutId = (socket as any).connectTimeoutTimer as number

    timers.runTimeout(workerTimeoutId)

    expect(worker.port.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]?.url).toBe("ws://localhost/ws")
    socket.dispose()
  })

  test("pings a stale open connection and resolves when acked", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    const healthCheck = socket.ensureHealthyConnection()
    const ping = ws.sent[0]

    expect(ping?.type).toBe("command")
    expect(ping?.command).toEqual({ type: "system.ping" })

    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await healthCheck

    expect(FakeWebSocket.instances).toHaveLength(1)
    socket.dispose()
  })

  test("reconnects immediately when a stale ping times out", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    firstWs.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    const healthCheck = socket.ensureHealthyConnection()
    timers.runTimeout((socket as any).pingTimeoutTimer)

    await expect(healthCheck).rejects.toThrow("Disconnected")
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]?.readyState).toBe(FakeWebSocket.CONNECTING)
    socket.dispose()
  })

  test("runs health checks on focus, visibility restore, and online", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    windowTarget.dispatchEvent("focus")
    let ping = ws.sent.pop()
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()

    documentTarget.visibilityState = "hidden"
    documentTarget.dispatchEvent("visibilitychange")
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    documentTarget.visibilityState = "visible"
    documentTarget.dispatchEvent("visibilitychange")
    ping = ws.sent.pop()
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()

    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    windowTarget.dispatchEvent("online")
    ping = ws.sent.pop()

    expect(ping?.command).toEqual({ type: "system.ping" })
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()
    socket.dispose()
  })

  test("keeps queued commands and flushes them once the socket opens", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    const pingPromise = socket.command({ type: "system.ping" })

    expect(ws.sent).toHaveLength(0)

    ws.open()
    const ping = ws.sent[0]
    ws.receive({ v: 1, type: "ack", id: ping?.id })

    await expect(pingPromise).resolves.toBeUndefined()
    expect(ws.sent).toHaveLength(1)
    socket.dispose()
  })

  test("rejects an unanswered command and reconnects instead of leaving the UI pending", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    firstWs.open()
    const command = socket.command({ type: "system.ping" })
    const commandTimeoutId = [...timers.timeouts.keys()].find((id) => id !== (socket as any).heartbeatTimer)

    expect(commandTimeoutId).toBeDefined()
    timers.runTimeout(commandTimeoutId!)

    await expect(command).rejects.toThrow("Request timed out")
    expect(FakeWebSocket.instances).toHaveLength(2)
    socket.dispose()
  })

  test("replays chat.send with its original command ID after a local server restart", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    firstWs.open()

    const sent = socket.command<{ chatId: string }>({
      type: "chat.send",
      chatId: "chat-1",
      content: "do not lose this prompt",
    })
    const firstEnvelope = firstWs.sent[0]!
    firstWs.close()

    const reconnectTimerId = (socket as any).reconnectTimer as number
    timers.runTimeout(reconnectTimerId)
    const secondWs = FakeWebSocket.instances[1]!
    secondWs.open()

    expect(secondWs.sent[0]).toEqual(firstEnvelope)
    secondWs.receive({
      v: 1,
      type: "ack",
      id: firstEnvelope.id,
      result: { chatId: "chat-1" },
    })
    await expect(sent).resolves.toEqual({ chatId: "chat-1" })
    socket.dispose()
  })

  test("replays an in-turn message enqueue instead of restoring it to the composer", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    firstWs.open()

    const sent = socket.command<{ queuedMessageId: string }>({
      type: "message.enqueue",
      chatId: "chat-1",
      content: "keep this queued prompt",
    })
    const firstEnvelope = firstWs.sent[0]!
    firstWs.close()

    timers.runTimeout((socket as any).reconnectTimer as number)
    const secondWs = FakeWebSocket.instances[1]!
    secondWs.open()

    expect(secondWs.sent[0]).toEqual(firstEnvelope)
    secondWs.receive({
      v: 1,
      type: "ack",
      id: firstEnvelope.id,
      result: { queuedMessageId: "queued-1" },
    })
    await expect(sent).resolves.toEqual({ queuedMessageId: "queued-1" })
    socket.dispose()
  })

  test("keeps chat.send pending and retries it when its ACK times out", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    firstWs.open()

    const sent = socket.command<{ chatId: string }>({
      type: "chat.send",
      chatId: "chat-1",
      content: "retry after a hung local server",
    })
    const firstEnvelope = firstWs.sent[0]!
    const timeoutID = (socket as any).pending.get(firstEnvelope.id).timeoutId as number
    timers.runTimeout(timeoutID)

    const secondWs = FakeWebSocket.instances[1]!
    secondWs.open()
    expect(secondWs.sent[0]).toEqual(firstEnvelope)
    secondWs.receive({ v: 1, type: "ack", id: firstEnvelope.id, result: { chatId: "chat-1" } })
    await expect(sent).resolves.toEqual({ chatId: "chat-1" })
    socket.dispose()
  })

  test("does not replay queued subscribe envelopes after sending active subscriptions on open", () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    socket.subscribe({ type: "sidebar" }, () => {})
    socket.subscribe({ type: "chat", chatId: "chat-1" }, () => {})

    expect(ws.sent).toHaveLength(0)

    ws.open()

    expect(ws.sent.map((message) => message.type)).toEqual(["subscribe", "subscribe"])
    expect(ws.sent.map((message) => message.topic)).toEqual([
      { type: "sidebar" },
      { type: "chat", chatId: "chat-1" },
    ])
    socket.dispose()
  })

  test("profiles starting chat snapshots with null messages without crashing", () => {
    ;(window as unknown as { sessionStorage: { getItem: () => string } }).sessionStorage.getItem = () => "1"
    const debugCalls: unknown[][] = []
    restoreGlobals.push(replaceGlobalProperty("console", {
      ...console,
      debug: (...args: unknown[]) => debugCalls.push(args),
    }))
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    expect(() => {
      ws.receive({
        v: 1,
        type: "snapshot",
        id: "sub-1",
        snapshot: {
          type: "chat",
          data: {
            runtime: {
              chatId: "chat-1",
              status: "starting",
            },
            messages: null,
          },
        },
      })
    }).not.toThrow()
    expect(debugCalls[0]?.[1]).toMatchObject({ messageCount: 0 })
    socket.dispose()
  })

  test("sends heartbeat checks while visible", async () => {
    const socket = new AbolqasemSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    timers.runInterval((socket as any).heartbeatTimer)

    expect(ws.sent[0]?.command).toEqual({ type: "system.ping" })
    ws.receive({ v: 1, type: "ack", id: ws.sent[0]?.id })
    await Promise.resolve()
    socket.dispose()
  })
})
