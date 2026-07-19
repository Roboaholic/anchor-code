import Editor from "@monaco-editor/react";

export function CodeViewer({
  path,
  content,
  language,
  truncated,
}: {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
}) {
  return (
    <div className="code-viewer">
      {truncated ? (
        <div className="banner banner--warn">
          File is larger than 1 MB — showing the first portion only ({path}).
        </div>
      ) : null}
      <div className="code-viewer__editor">
        <Editor
          path={path}
          language={language}
          value={content}
          theme="light"
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            fontFamily:
              'SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, monospace',
            scrollBeyondLastLine: false,
            wordWrap: "on",
            renderLineHighlight: "line",
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
            contextmenu: true,
            folding: true,
            stickyScroll: { enabled: false },
          }}
          loading={<div className="viewer-loading">Loading editor…</div>}
        />
      </div>
    </div>
  );
}
