import { afterEach, expect, test } from "bun:test"
import { replaceGlobalProperty, restoreGlobalProperties } from "../test/globalProperty"

type EventHandler = (event?: any) => void

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

  emit(type: string, event?: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class FakePort extends FakeEventTarget {
  readonly messages: unknown[] = []
  start() {}
  close() {}
  postMessage(message: unknown) {
    this.messages.push(message)
  }
  receive(message: unknown) {
    this.emit("message", { data: message })
  }
}

class FakeWebSocket extends FakeEventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit("open")
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit("close")
  }
}

let restores: Array<() => void> = []

afterEach(() => {
  restoreGlobalProperties(restores)
  restores = []
  FakeWebSocket.instances = []
})

test("SharedWorker replays delivery commands when reconnect is requested explicitly", async () => {
  const workerScope: { onconnect: ((event: MessageEvent) => void) | null } = { onconnect: null }
  restores = [
    replaceGlobalProperty("self", workerScope),
    replaceGlobalProperty("WebSocket", FakeWebSocket),
  ]
  await import("./socket.shared-worker")

  const port = new FakePort()
  workerScope.onconnect?.({ ports: [port] } as unknown as MessageEvent)
  port.receive({ type: "start", url: "ws://localhost/ws" })
  const firstSocket = FakeWebSocket.instances[0]!
  firstSocket.open()

  const envelope = {
    v: 1,
    type: "command",
    id: "delivery-1",
    command: { type: "message.enqueue", chatId: "chat-1", content: "never lose me" },
  }
  port.receive({ type: "send", envelope })
  expect(JSON.parse(firstSocket.sent[0]!)).toEqual(envelope)

  port.receive({ type: "reconnect" })
  const secondSocket = FakeWebSocket.instances[1]!
  secondSocket.open()

  expect(JSON.parse(secondSocket.sent[0]!)).toEqual(envelope)
  port.receive({ type: "dispose" })
})
