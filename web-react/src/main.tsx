import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/bricolage-grotesque"
import "@fontsource-variable/vazirmatn"
import "@fontsource-variable/noto-naskh-arabic"
import "@fontsource-variable/noto-kufi-arabic"
import { AppBootstrap } from "./client/app/AppBootstrap"
import "@xterm/xterm/css/xterm.css"
import "./index.css"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

// A deploy can remove an old content-hashed chunk while an already-open tab
// still has the previous index in memory. Vite emits this event when a lazy
// import then fails; reload once so the new index and asset graph are fetched.
// The session guard prevents a persistent network failure from becoming an
// infinite reload loop.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault()
  const reloadKey = "abolqasem:asset-reload-at"
  const now = Date.now()
  try {
    const previous = Number(window.sessionStorage.getItem(reloadKey) ?? 0)
    if (Number.isFinite(previous) && now - previous < 10_000) return
    window.sessionStorage.setItem(reloadKey, String(now))
  } catch {
    // If storage is unavailable, still perform the one useful recovery.
  }
  window.location.reload()
})

createRoot(container).render(
  <StrictMode>
    <AppBootstrap />
  </StrictMode>
)
