/**
 * Configure Monaco for Electron + Vite without CDN.
 * @monaco-editor/react defaults to jsDelivr; CSP blocks it → infinite "Loading editor…".
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let configured = false;

export function ensureMonacoConfigured(): void {
  if (configured) return;
  configured = true;

  // Workers must be local (Vite ?worker), not CDN.
  self.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === "json") return new jsonWorker();
      if (label === "css" || label === "scss" || label === "less") {
        return new cssWorker();
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new htmlWorker();
      }
      if (label === "typescript" || label === "javascript") {
        return new tsWorker();
      }
      return new editorWorker();
    },
  };

  loader.config({ monaco });
}

// Configure as soon as this module is imported.
ensureMonacoConfigured();
