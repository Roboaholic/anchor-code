import "./compat";
import React from "react";
import ReactDOM from "react-dom/client";
import App, { parsePairingPayload, type AppOverrides } from "./App";
import { createBaselineFixture } from "./baselineFixture";
import "./styles.css";

window.addEventListener("error", (event) => {
  const stack = event.error instanceof Error ? event.error.stack : "";
  console.error(`[window-error] ${event.message}\n${stack || ""}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack || ""}` : String(event.reason);
  console.error(`[unhandled-rejection] ${reason}`);
});

const query = new URLSearchParams(window.location.search);
const baseline = import.meta.env.DEV && query.get("baseline") === "1"
  ? createBaselineFixture()
  : undefined;
let automatedPairing: AppOverrides | undefined;
const pairingPayload = query.get("appsimPairing");
if (pairingPayload) {
  try {
    automatedPairing = { initialConnection: parsePairingPayload(pairingPayload) };
    console.info("[app-simulation] accepted debug pairing payload");
  } catch (error) {
    console.error("[app-simulation] invalid debug pairing payload", error);
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App {...(baseline ?? automatedPairing)} />
  </React.StrictMode>,
);
