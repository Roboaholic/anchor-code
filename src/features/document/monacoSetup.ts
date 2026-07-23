/**
 * Configure Monaco for Electron + Vite without CDN.
 * Registers neutral zinc / warm-sand themes aligned with CSS tokens.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let configured = false;
let themesRegistered = false;

function registerAnchorThemes(m: typeof monaco): void {
  if (themesRegistered) return;
  themesRegistered = true;

  // Surfaces match --bg / --bg-panel; accents warm sand (no blue chrome).
  m.editor.defineTheme("anchor-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#101011",
      "editor.foreground": "#ececec",
      "editorLineNumber.foreground": "#5a5a60",
      "editorLineNumber.activeForeground": "#a8a8ad",
      "editorCursor.foreground": "#d2b48c",
      "editor.selectionBackground": "#3a342680",
      "editor.inactiveSelectionBackground": "#2c292255",
      "editor.lineHighlightBackground": "#1e1e2080",
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background": "#2e2e32",
      "editorIndentGuide.activeBackground": "#3f3f44",
      "editorWidget.background": "#171718",
      "editorWidget.border": "#2e2e32",
      "editorWidget.foreground": "#ececec",
      "editorSuggestWidget.background": "#171718",
      "editorSuggestWidget.border": "#2e2e32",
      "editorSuggestWidget.selectedBackground": "#2c2922",
      "editorSuggestWidget.foreground": "#ececec",
      "editorHoverWidget.background": "#171718",
      "editorHoverWidget.border": "#2e2e32",
      "editorHoverWidget.foreground": "#ececec",
      // Context menu — same surface as shell panels (not default blue-gray)
      "menu.background": "#171718",
      "menu.foreground": "#a8a8ad",
      "menu.border": "#2e2e32",
      "menu.separatorBackground": "#2e2e32",
      "menu.selectionBackground": "#2c2922",
      "menu.selectionForeground": "#c4a882",
      "menu.selectionBorder": "#00000000",
      "list.hoverBackground": "#1e1e20",
      "list.activeSelectionBackground": "#2c2922",
      "list.activeSelectionForeground": "#c4a882",
      "list.focusBackground": "#2c2922",
      "list.focusForeground": "#c4a882",
      "list.inactiveSelectionBackground": "#1e1e20",
      "list.inactiveSelectionForeground": "#ececec",
      "editorActionList.background": "#171718",
      "editorActionList.foreground": "#a8a8ad",
      "editorActionList.focusBackground": "#2c2922",
      "editorActionList.focusForeground": "#c4a882",
      "widget.shadow": "#00000066",
      "scrollbarSlider.background": "#3f3f4466",
      "scrollbarSlider.hoverBackground": "#3f3f4499",
      "scrollbarSlider.activeBackground": "#3f3f44cc",
      "minimap.background": "#101011",
      "diffEditor.insertedTextBackground": "#2a403580",
      "diffEditor.removedTextBackground": "#4a282880",
      "diffEditor.insertedLineBackground": "#1a2e2480",
      "diffEditor.removedLineBackground": "#3a222280",
      "editorGutter.background": "#101011",
      "editorOverviewRuler.border": "#00000000",
    },
  });

  m.editor.defineTheme("anchor-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#faf9f7",
      "editor.foreground": "#1c1b19",
      "editorLineNumber.foreground": "#a8a39a",
      "editorLineNumber.activeForeground": "#5c5954",
      "editorCursor.foreground": "#8a6a2f",
      "editor.selectionBackground": "#e8d9b580",
      "editor.inactiveSelectionBackground": "#e8e4db66",
      "editor.lineHighlightBackground": "#eceae680",
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background": "#ddd9d1",
      "editorIndentGuide.activeBackground": "#c9c3b8",
      "editorWidget.background": "#faf9f7",
      "editorWidget.border": "#ddd9d1",
      "editorWidget.foreground": "#1c1b19",
      "editorSuggestWidget.background": "#faf9f7",
      "editorSuggestWidget.border": "#ddd9d1",
      "editorSuggestWidget.selectedBackground": "#e8e4db",
      "editorSuggestWidget.foreground": "#1c1b19",
      "editorHoverWidget.background": "#faf9f7",
      "editorHoverWidget.border": "#ddd9d1",
      "editorHoverWidget.foreground": "#1c1b19",
      "menu.background": "#faf9f7",
      "menu.foreground": "#5c5954",
      "menu.border": "#ddd9d1",
      "menu.separatorBackground": "#ddd9d1",
      "menu.selectionBackground": "#e8e4db",
      "menu.selectionForeground": "#8a6a2f",
      "menu.selectionBorder": "#00000000",
      "list.hoverBackground": "#eceae6",
      "list.activeSelectionBackground": "#e8e4db",
      "list.activeSelectionForeground": "#8a6a2f",
      "list.focusBackground": "#e8e4db",
      "list.focusForeground": "#8a6a2f",
      "list.inactiveSelectionBackground": "#eceae6",
      "list.inactiveSelectionForeground": "#1c1b19",
      "editorActionList.background": "#faf9f7",
      "editorActionList.foreground": "#5c5954",
      "editorActionList.focusBackground": "#e8e4db",
      "editorActionList.focusForeground": "#8a6a2f",
      "widget.shadow": "#1c1b1926",
      "scrollbarSlider.background": "#c9c3b866",
      "scrollbarSlider.hoverBackground": "#c9c3b899",
      "scrollbarSlider.activeBackground": "#c9c3b8cc",
      "minimap.background": "#faf9f7",
      "diffEditor.insertedTextBackground": "#d1fae580",
      "diffEditor.removedTextBackground": "#fee2e280",
      "diffEditor.insertedLineBackground": "#ecfdf580",
      "diffEditor.removedLineBackground": "#fef2f280",
      "editorGutter.background": "#faf9f7",
      "editorOverviewRuler.border": "#00000000",
    },
  });
}

export function ensureMonacoConfigured(): void {
  if (configured) return;
  configured = true;

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
  registerAnchorThemes(monaco);
}

// Configure as soon as this module is imported.
ensureMonacoConfigured();
