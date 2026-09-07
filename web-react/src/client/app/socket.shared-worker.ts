import type { ClientEnvelope, ServerEnvelope } from "../../shared/protocol"

type WorkerRequest =
  | { type: "start"; url: string }
  | { type: "send"; envelope: ClientEnvelope }
  | { type: "cancel-command"; id: string }
  | { type: "reconnect" }
  | { type: "dispose" }

type WorkerResponse = { type: "status"; status: "connecting" | "connected" | "disconnected" } | { type: "message"; payload: string }
type SharedWorkerStatus = "connecting" | "connected" | "disconnected"
interface SharedWorkerScopeLike {
  onconnect: ((event: MessageEvent) => void) | null
}

const RECONNECT_INITIAL_DELAY_MS = 750
const RECONNECT_MAX_DELAY_MS = 5_000
const CONNECT_TIMEOUT_MS = 4_000

function isRetryableCommand(envelope: ClientEnvelope) {
  if (envelope.type !== "command") return false
  return envelope.command.type === "chat.send"
    || envelope.command.type === "message.enqueue"
    || envelope.command.type === "message.steer"
    || envelope.command.type === "message.interrupt"
}

const workerScope = self as unknown as SharedWorkerScopeLike
const ports = new Set<MessagePort>()
const subscriptionOwners = new Map<string, MessagePort>()
const commandOwners = new Map<string, MessagePort>()
const retryableCommands = new Map<string, ClientEnvelope>()
const subscriptions = new Map<string, ClientEnvelope>()
const outboundQueue: ClientEnvelope[] = []

let socket: WebSocket | null = null
let socketURL = ""
let reconnectTimer: number | null = null
let connectTimeoutTimer: number | null = null
let reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS
let status: SharedWorkerStatus = "disconnected"

workerScope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0]
  if (!port) return
  port.start()
  port.addEventListener("message", (messageEvent: MessageEvent<WorkerRequest>) => {
    handlePortMessage(port, messageEvent.data)
  })
}

function handlePortMessage(port: MessagePort, message: WorkerRequest) {
  switch (message.type) {
    case "start":
      ports.add(port)
      socketURL = message.url
      post(port, { type: "status", status })
      connect()
      return
    case "send":
      trackEnvelope(port, message.envelope)
      send(message.envelope)
      return
    case "cancel-command":
      commandOwners.delete(message.id)
      retryableCommands.delete(message.id)
      discardQueuedCommand(message.id)
      return
    case "reconnect":
      reconnectNow()
      return
    case "dispose":
      disposePort(port)
      return
  }
}

function trackEnvelope(port: MessagePort, envelope: ClientEnvelope) {
  if (!envelope.id) return
  if (envelope.type === "subscribe") {
    subscriptionOwners.set(envelope.id, port)
    subscriptions.set(envelope.id, envelope)
    return
  }
  if (envelope.type === "unsubscribe") {
    subscriptionOwners.delete(envelope.id)
    subscriptions.delete(envelope.id)
    return
  }
  if (envelope.type === "command") {
    commandOwners.set(envelope.id, port)
    if (isRetryableCommand(envelope)) retryableCommands.set(envelope.id, envelope)
  }
}

function disposePort(port: MessagePort) {
  ports.delete(port)
  for (const [subscriptionID, owner] of subscriptionOwners) {
    if (owner !== port) continue
    subscriptionOwners.delete(subscriptionID)
    subscriptions.delete(subscriptionID)
    send({ v: 1, type: "unsubscribe", id: subscriptionID })
  }
  for (const [commandID, owner] of commandOwners) {
    if (owner !== port) continue
    commandOwners.delete(commandID)
    retryableCommands.delete(commandID)
    discardQueuedCommand(commandID)
  }
  port.close()
  if (ports.size === 0) closeSocket()
}

function connect() {
  if (!socketURL || ports.size === 0 || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
  setStatus("connecting")
  const nextSocket = new WebSocket(socketURL)
  socket = nextSocket
  connectTimeoutTimer = setTimeout(() => {
    connectTimeoutTimer = null
    if (socket !== nextSocket || nextSocket.readyState !== WebSocket.CONNECTING) return

    // Browsers may leave a local WebSocket in CONNECTING for minutes while a
    // server binary is being replaced. Do not let that browser-level timeout
    // hold the entire UI splash screen.
    socket = null
    nextSocket.close()
    setStatus("disconnected")
    scheduleReconnect()
  }, CONNECT_TIMEOUT_MS) as unknown as number
  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) {
      nextSocket.close()
      return
    }
    clearConnectTimeout()
    reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS
    setStatus("connected")
    for (const envelope of subscriptions.values()) sendNow(envelope)
    while (outboundQueue.length > 0) {
      const envelope = outboundQueue.shift()
      if (!envelope || (envelope.type === "command" && !commandOwners.has(envelope.id))) continue
      sendNow(envelope)
    }
  })
  nextSocket.addEventListener("message", (event) => {
    if (socket === nextSocket) routeServerMessage(String(event.data))
  })
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return
    clearConnectTimeout()
    socket = null
    // Keep chat.send ownership and replay the exact same envelope after a
    // local-server restart. Non-idempotent UI commands retain the old failure
    // semantics and are allowed to be rejected by the page.
    for (const envelope of retryableCommands.values()) enqueueRetryableCommand(envelope)
    for (const [commandID] of commandOwners) {
      if (!retryableCommands.has(commandID)) commandOwners.delete(commandID)
    }
    setStatus("disconnected")
    scheduleReconnect()
  })
  nextSocket.addEventListener("error", () => nextSocket.close())
}

function closeSocket() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  clearConnectTimeout()
  const currentSocket = socket
  socket = null
  currentSocket?.close()
  setStatus("disconnected")
}

function reconnectNow() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    queueRetryableCommands()
    connect()
    return
  }
  clearConnectTimeout()
  // We detach the old socket before closing it so its late events cannot
  // affect the replacement. Queue pending deliveries here, because that same
  // guard intentionally makes the old socket's close handler a no-op.
  queueRetryableCommands()
  const currentSocket = socket
  socket = null
  currentSocket.close()
  setStatus("disconnected")
  connect()
}

function clearConnectTimeout() {
  if (connectTimeoutTimer === null) return
  clearTimeout(connectTimeoutTimer)
  connectTimeoutTimer = null
}

function scheduleReconnect() {
  if (reconnectTimer !== null || ports.size === 0) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS)
  }, reconnectDelayMs) as unknown as number
}

function send(envelope: ClientEnvelope) {
  if (socket?.readyState === WebSocket.OPEN) {
    sendNow(envelope)
    return
  }
  if (envelope.type === "subscribe" || envelope.type === "unsubscribe") {
    connect()
    return
  }
  if (isRetryableCommand(envelope)) {
    enqueueRetryableCommand(envelope)
  } else {
    outboundQueue.push(envelope)
  }
  connect()
}

function sendNow(envelope: ClientEnvelope) {
  socket?.send(JSON.stringify(envelope))
}

function discardQueuedCommand(commandID: string) {
  for (let index = outboundQueue.length - 1; index >= 0; index--) {
    const envelope = outboundQueue[index]
    if (envelope?.type === "command" && envelope.id === commandID) outboundQueue.splice(index, 1)
  }
}

function enqueueRetryableCommand(envelope: ClientEnvelope) {
  if (outboundQueue.some((queued) => queued.type === "command" && queued.id === envelope.id)) return
  outboundQueue.push(envelope)
}

function queueRetryableCommands() {
  for (const envelope of retryableCommands.values()) enqueueRetryableCommand(envelope)
}

function routeServerMessage(payload: string) {
  let envelope: ServerEnvelope
  try {
    envelope = JSON.parse(payload) as ServerEnvelope
  } catch {
    return
  }
  if (!envelope.id) return
  const owner = envelope.type === "snapshot" || envelope.type === "event" ? subscriptionOwners.get(envelope.id) : commandOwners.get(envelope.id)
  if (!owner) return
  if (envelope.type === "ack" || envelope.type === "error") {
    commandOwners.delete(envelope.id)
    retryableCommands.delete(envelope.id)
  }
  post(owner, { type: "message", payload })
}

function setStatus(nextStatus: SharedWorkerStatus) {
  status = nextStatus
  for (const port of ports) post(port, { type: "status", status })
}

function post(port: MessagePort, message: WorkerResponse) {
  port.postMessage(message)
}
