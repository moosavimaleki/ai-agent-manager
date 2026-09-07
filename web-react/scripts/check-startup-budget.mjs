import { existsSync, readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { join } from "node:path"

const clientDir = join(import.meta.dirname, "..", "dist", "client")
const manifestPath = join(clientDir, ".vite", "manifest.json")

if (!existsSync(manifestPath)) {
  throw new Error(`Startup budget cannot run: missing ${manifestPath}`)
}

/** @type {Record<string, { file: string, imports?: string[] }>} */
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

function closure(key, visited = new Set()) {
  if (visited.has(key)) return visited
  const chunk = manifest[key]
  if (!chunk) throw new Error(`Startup budget references missing manifest chunk: ${key}`)
  visited.add(key)
  for (const dependency of chunk.imports ?? []) closure(dependency, visited)
  return visited
}

function sizeOf(keys) {
  const files = [...keys].map((key) => join(clientDir, manifest[key].file))
  const content = files.map((file) => readFileSync(file))
  return {
    raw: content.reduce((total, file) => total + file.byteLength, 0),
    gzip: gzipSync(Buffer.concat(content)).byteLength,
  }
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

// These are executable product constraints, not Vite warning thresholds. They
// protect the CPU-sensitive path measured in the supplied HAR files: bootstrap
// → authenticated shell → chat shell. Heavy renderers must stay dynamically
// loaded and transcript history is independently bounded by the server.
const appRuntimeKey = findKey("AppRuntime")
const chatShellKey = (manifest[appRuntimeKey].dynamicImports ?? []).find((key) => key.startsWith("_index-"))
if (!chatShellKey) throw new Error("Startup budget cannot find the chat shell dynamic import")

const budgets = [
  { name: "bootstrap", key: "index.html", raw: 220 * 1024, gzip: 70 * 1024 },
  { name: "authenticated shell", key: appRuntimeKey, raw: 560 * 1024, gzip: 180 * 1024 },
  { name: "chat shell", key: chatShellKey, raw: 1_280 * 1024, gzip: 400 * 1024 },
  { name: "transcript renderer", key: "src/client/app/ChatPage/ChatTranscriptViewport.tsx", raw: 1_360 * 1024, gzip: 440 * 1024 },
]

function findKey(fragment, predicate = (entry) => entry.includes(fragment)) {
  const key = Object.keys(manifest).find(predicate)
  if (!key) throw new Error(`Startup budget cannot find manifest chunk matching ${fragment}`)
  return key
}

let failed = false
for (const budget of budgets) {
  const measured = sizeOf(closure(budget.key))
  const status = measured.raw <= budget.raw && measured.gzip <= budget.gzip ? "ok" : "OVER"
  console.log(`[startup-budget] ${status} ${budget.name}: ${kib(measured.raw)} raw, ${kib(measured.gzip)} gzip`)
  if (status === "OVER") {
    console.error(`  budget: ${kib(budget.raw)} raw, ${kib(budget.gzip)} gzip`)
    failed = true
  }
}

if (failed) process.exitCode = 1
