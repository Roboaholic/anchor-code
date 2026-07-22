import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/500.css";
import "@vscode/codicons/dist/codicon.css";
import "./styles/global.css";

// macOS Electron uses hiddenInset titlebar; Windows/Linux keep default chrome.
if (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)) {
  document.documentElement.dataset.platform = "darwin";
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
