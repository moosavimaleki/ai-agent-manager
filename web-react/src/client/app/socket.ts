import type { ClientCommand, ClientEnvelope, ServerEnvelope, SubscriptionTopic, TerminalEvent, TerminalSnapshot } from "../../shared/protocol"
import { LOG_PREFIX } from "../../shared/branding"
import { generateUUID } from "../lib/utils"

type SnapshotListener<T> = (value: T) => void
type EventListener<T> = (value: T) => void
export type SocketStatus = "connecting" | "connected" | "disconnected"
type StatusListener = (status: SocketStatus) => void

const STALE_CONNECTION_MS = 25_000
const HEARTBEAT_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 4_000
const CONNECT_TIMEOUT_MS = 4_000
// Commands must never leave a view in an indeterminate state. The server is
// local, so a response taking this long means the connection needs recovery,
// not that the UI should wait forever.
// Provider startup and a large local snapshot can briefly occupy the server's
// websocket writer. Give commands enough time to cross that local boundary;
// the heartbeat still detects a genuinely dead connection much sooner.
const COMMAND_TIMEOUT_MS = 30_000
const SEND_TO_STARTING_PROFILE_STORAGE_KEY = "abolqasem:profile-send-to-starting"

interface SubscriptionEntry<TSnapshot, TEvent = never> {
  topic: SubscriptionTopic
  listener: SnapshotListener<TSnapshot>
  eventListener?: EventListener<TEvent>
}

function shouldRetryAfterReconnect(command: ClientCommand) {
  // Every command that can hand user-authored text to an agent must survive a
  // local viewer restart. The server deduplicates these envelope IDs, so the
  // browser can safely replay them until their ACK reaches the owning tab.
  return command.type === "chat.send"
    || command.type === "message.enqueue"
    || command.type === "message.steer"
    || command.type === "message.interrupt"
}

function isSendToStartingProfilingEnabled() {
  try {
    return (
      window.sessionStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1" || window.localStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
    )
  } catch {
    return false
  }
}

export class AbolqasemSocket {
  private readonly url: string
  private ws: WebSocket | null = null
  private started = false
  private reconnectTimer: number | null = null
  private connectTimeoutTimer: number | null = null
  private reconnectDelayMs = 750
  private readonly subscriptions = new Map<string, SubscriptionEntry<unknown, unknown>>()
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (reason?: unknown) => void
      timeoutId: number | null
      envelope: ClientEnvelope
      retryAfterReconnect: boolean
    }
  >()
  private readonly outboundQueue: ClientEnvelope[] = []
  private readonly statusListeners = new Set<StatusListener>()
  private heartbeatTimer: number | null = null
  private pingTimeoutTimer: number | null = null
  private pingPromise: Promise<void> | null = null
  private lastOpenAt = 0
  private lastMessageAt = 0
  private reconnectImmediatelyOnClose = false
  private readonly handleWindowFocus = () => {
    void this.ensureHealthyConnection()
  }
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.startHeartbeat()
      void this.ensureHealthyConnection()
      return
    }
    this.stopHeartbeat()
  }
  private readonly handleOnline = () => {
    void this.ensureHealthyConnection()
  }

  constructor(url: string) {
    this.url = url
  }

  start() {
    if (this.started) {
      return
    }
    this.started = true
    window.addEventListener("focus", this.handleWindowFocus)
    window.addEventListener("online", this.handleOnline)
    document.addEventListener("visibilitychange", this.handleVisibilityChange)
    this.connect()
  }

  dispose() {
    this.started = false
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    this.clearPingState()
    this.clearConnectTimeout()
    window.removeEventListener("focus", this.handleWindowFocus)
    window.removeEventListener("online", this.handleOnline)
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    this.ws?.close()
    this.ws = null
    for (const pending of this.pending.values()) {
      this.clearPendingTimeout(pending)
      pending.reject(new Error("Socket disposed"))
    }
    this.pending.clear()
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener)
    listener(this.getStatus())
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  subscribe<TSnapshot, TEvent = never>(topic: SubscriptionTopic, listener: SnapshotListener<TSnapshot>, eventListener?: EventListener<TEvent>) {
    const id = generateUUID()
    this.subscriptions.set(id, {
      topic,
      listener: listener as SnapshotListener<unknown>,
      eventListener: eventListener as EventListener<unknown> | undefined,
    })
    this.enqueue({ v: 1, type: "subscribe", id, topic })
    return () => {
      this.subscriptions.delete(id)
      this.enqueue({ v: 1, type: "unsubscribe", id })
    }
  }

  subscribeTerminal(
    terminalId: string,
    handlers: {
      onSnapshot: SnapshotListener<TerminalSnapshot | null>
      onEvent?: EventListener<TerminalEvent>
    }
  ) {
    const id = generateUUID()
    const topic: SubscriptionTopic = { type: "terminal", terminalId }
    this.subscriptions.set(id, {
      topic,
      listener: handlers.onSnapshot as SnapshotListener<unknown>,
      eventListener: handlers.onEvent as EventListener<unknown> | undefined,
    })
    this.enqueue({ v: 1, type: "subscribe", id, topic })
    return () => {
      this.subscriptions.delete(id)
      this.enqueue({ v: 1, type: "unsubscribe", id })
    }
  }

  command<TResult = unknown>(command: ClientCommand) {
    const id = generateUUID()
    const envelope: ClientEnvelope = { v: 1, type: "command", id, command }
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId: null,
        envelope,
        retryAfterReconnect: shouldRetryAfterReconnect(command),
      })
      this.armCommandTimeout(id)
      this.enqueue(envelope)
    })
  }

  ensureHealthyConnection() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.reconnectNow()
      return Promise.resolve()
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      return Promise.resolve()
    }

    if (!this.isConnectionStale()) {
      return Promise.resolve()
    }

    return this.sendPing()
  }

  private connect() {
    if (!this.started) {
      return
    }
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return
    }
    this.emitStatus("connecting")
    const nextSocket = new WebSocket(this.url)
    this.ws = nextSocket
    this.connectTimeoutTimer = window.setTimeout(() => {
      this.connectTimeoutTimer = null
      if (this.ws !== nextSocket || nextSocket.readyState !== WebSocket.CONNECTING) return
      this.ws = null
      nextSocket.close()
      this.emitStatus("disconnected")
      this.scheduleReconnect()
    }, CONNECT_TIMEOUT_MS)

    nextSocket.addEventListener("open", () => {
      if (this.ws !== nextSocket) {
        nextSocket.close()
        return
      }
      this.clearConnectTimeout()
      this.reconnectDelayMs = 750
      this.reconnectImmediatelyOnClose = false
      this.lastOpenAt = Date.now()
      this.lastMessageAt = this.lastOpenAt
      this.emitStatus("connected")
      this.startHeartbeat()
      for (const [id, subscription] of this.subscriptions.entries()) {
        this.sendNow({ v: 1, type: "subscribe", id, topic: subscription.topic })
      }
      while (this.outboundQueue.length > 0) {
        const envelope = this.outboundQueue.shift()
        if (envelope) {
          if (envelope.type === "subscribe" || envelope.type === "unsubscribe") {
            continue
          }
          this.sendNow(envelope)
        }
      }
    })

    nextSocket.addEventListener("message", (event) => {
      if (this.ws === nextSocket) this.handleServerMessage(String(event.data))
    })

    nextSocket.addEventListener("close", () => {
      if (this.ws !== nextSocket) return
      this.clearConnectTimeout()
      this.ws = null
      if (!this.started) {
        return
      }
      const reconnectImmediately = this.reconnectImmediatelyOnClose
      this.reconnectImmediatelyOnClose = false
      this.stopHeartbeat()
      this.clearPingState()
      this.emitStatus("disconnected")
      this.rejectPendingCommands("Disconnected")
      if (reconnectImmediately) {
        this.connect()
        return
      }
      this.scheduleReconnect()
    })
  }

  private handleServerMessage(rawText: string) {
    this.lastMessageAt = Date.now()
    const receivedAt = performance.now()
    let payload: ServerEnvelope
    try {
      payload = JSON.parse(rawText) as ServerEnvelope
    } catch {
      return
    }

    if (
      isSendToStartingProfilingEnabled() &&
      payload.type === "snapshot" &&
      payload.snapshot.type === "chat" &&
      payload.snapshot.data?.runtime.status === "starting"
    ) {
      const messageCount = Array.isArray(payload.snapshot.data.messages) ? payload.snapshot.data.messages.length : 0
      console.debug("[abolqasem/send->starting][client-ws]", {
        stage: "socket_message_received",
        receivedAt,
        payloadBytes: rawText.length,
        chatId: payload.snapshot.data.runtime.chatId,
        status: payload.snapshot.data.runtime.status,
        messageCount,
      })
    }

    if (isSendToStartingProfilingEnabled() && payload.type === "ack") {
      console.debug("[abolqasem/send->starting][client-ws]", {
        stage: "socket_ack_received",
        receivedAt,
        payloadBytes: rawText.length,
        commandId: payload.id,
      })
    }

    if (payload.type === "snapshot") {
      this.subscriptions.get(payload.id)?.listener(payload.snapshot.data)
      return
    }
    if (payload.type === "event") {
      this.subscriptions.get(payload.id)?.eventListener?.(payload.event)
      return
    }
    if (payload.type === "ack") {
      const pending = this.pending.get(payload.id)
      if (!pending) return
      this.pending.delete(payload.id)
      this.clearPendingTimeout(pending)
      pending.resolve(payload.result)
      return
    }
    if (payload.type === "error") {
      if (!payload.id) {
        console.error(LOG_PREFIX, payload.message)
        return
      }
      const pending = this.pending.get(payload.id)
      if (!pending) return
      this.pending.delete(payload.id)
      this.clearPendingTimeout(pending)
      pending.reject(new Error(payload.message))
    }
  }

  private rejectPendingCommands(message: string) {
    for (const [id, pending] of this.pending) {
      if (pending.retryAfterReconnect) {
        this.enqueueRetryableCommand(pending.envelope)
        continue
      }
      this.clearPendingTimeout(pending)
      pending.reject(new Error(message))
      this.pending.delete(id)
    }
  }

  private armCommandTimeout(id: string) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.clearPendingTimeout(pending)
    pending.timeoutId = window.setTimeout(() => {
      const current = this.pending.get(id)
      if (!current) return
      if (current.retryAfterReconnect) {
        this.enqueueRetryableCommand(current.envelope)
        this.reconnectNow()
        this.armCommandTimeout(id)
        return
      }
      this.pending.delete(id)
      current.reject(new Error("Request timed out; reconnecting to the local server"))
      this.reconnectNow()
    }, COMMAND_TIMEOUT_MS)
  }

  private clearPendingTimeout(pending: { timeoutId: number | null }) {
    if (pending.timeoutId !== null) {
      window.clearTimeout(pending.timeoutId)
      pending.timeoutId = null
    }
  }

  private enqueueRetryableCommand(envelope: ClientEnvelope) {
    if (this.outboundQueue.some((queued) => queued.type === "command" && queued.id === envelope.id)) {
      return
    }
    this.outboundQueue.push(envelope)
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5_000)
    }, this.reconnectDelayMs)
  }

  private getStatus(): SocketStatus {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return "connected"
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return "connecting"
    }
    return "disconnected"
  }

  private emitStatus(status: SocketStatus) {
    for (const listener of this.statusListeners) {
      listener(status)
    }
  }

  private isConnectionStale() {
    const baseline = Math.max(this.lastMessageAt, this.lastOpenAt)
    return baseline > 0 && Date.now() - baseline >= STALE_CONNECTION_MS
  }

  private sendPing() {
    if (this.pingPromise) {
      return this.pingPromise
    }

    const pingPromise = this.command({ type: "system.ping" })
      .then(() => {
        this.clearPingState()
      })
      .catch((error) => {
        this.clearPingState()
        this.reconnectNow()
        throw error
      })

    this.pingTimeoutTimer = window.setTimeout(() => {
      this.clearPingState()
      this.reconnectNow()
    }, PING_TIMEOUT_MS)

    this.pingPromise = pingPromise
    return pingPromise
  }

  private reconnectNow() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect()
      return
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      return
    }

    this.reconnectImmediatelyOnClose = true
    this.ws.close()
  }

  private startHeartbeat() {
    if (document.visibilityState !== "visible") {
      return
    }

    if (this.heartbeatTimer !== null) {
      return
    }

    this.heartbeatTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        this.stopHeartbeat()
        return
      }
      if (this.getStatus() !== "connected") {
        return
      }
      void this.ensureHealthyConnection()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearPingState() {
    if (this.pingTimeoutTimer !== null) {
      window.clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }
    this.pingPromise = null
  }

  private clearConnectTimeout() {
    if (this.connectTimeoutTimer === null) return
    window.clearTimeout(this.connectTimeoutTimer)
    this.connectTimeoutTimer = null
  }

  private enqueue(envelope: ClientEnvelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendNow(envelope)
      return
    }
    this.outboundQueue.push(envelope)
  }

  private sendNow(envelope: ClientEnvelope) {
    this.ws?.send(JSON.stringify(envelope))
  }
}
