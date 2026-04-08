import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Global error handler — catches errors React error boundaries miss
// (async errors, module evaluation failures, unhandled rejections)
function showFatalError(msg: string) {
  const root = document.getElementById("root");
  if (root && (!root.hasChildNodes() || root.innerHTML === "")) {
    root.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0a0a;color:#fff;font-family:sans-serif;padding:2rem">
        <div style="max-width:600px;text-align:center">
          <h2 style="margin-bottom:1rem">Something went wrong</h2>
          <pre style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1rem;text-align:left;overflow-x:auto;font-size:13px;color:#f87171;white-space:pre-wrap;word-break:break-all">${msg}</pre>
          <button onclick="location.reload()" style="margin-top:1rem;padding:8px 20px;border-radius:6px;background:#c9a86a;color:#000;border:none;cursor:pointer;font-weight:600">Reload</button>
        </div>
      </div>`;
  }
}

window.onerror = (_msg, _src, _line, _col, err) => {
  console.error("[global onerror]", err);
  showFatalError(err?.stack || err?.message || String(_msg));
};

window.onunhandledrejection = (e: PromiseRejectionEvent) => {
  console.error("[unhandledrejection]", e.reason);
  showFatalError(e.reason?.stack || e.reason?.message || String(e.reason));
};

createRoot(document.getElementById("root")!).render(<App />);
