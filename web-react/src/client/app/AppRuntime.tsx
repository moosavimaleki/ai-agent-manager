import { BrowserRouter } from "react-router-dom"
import { ThemeProvider } from "../hooks/useTheme"
import { App } from "./App"

// Keep router, theme state, and the complete application graph out of the
// bootstrap bundle. They are useful only after /auth/status has answered.
export function AppRuntime() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  )
}
