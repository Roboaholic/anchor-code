export function TerminalPanel() {
  return (
    <aside className="terminal-panel">
      <header className="terminal-panel__header">
        <span className="terminal-panel__title">TERMINAL</span>
        <button type="button" className="icon-btn" aria-label="Terminal menu" disabled>
          ⋮
        </button>
      </header>

      <div className="terminal-tabs" role="tablist">
        <button type="button" className="term-tab is-active" role="tab">
          1: zsh
        </button>
        <button type="button" className="term-tab" role="tab" disabled>
          2: node
        </button>
        <button type="button" className="term-tab term-tab--add" aria-label="New terminal" disabled>
          +
        </button>
      </div>

      <div className="terminal-panel__body">
        <pre className="terminal-mock">
{`$ # PTY arrives in Slice 5
$ # cwd will follow workspace root
$ # paste session YAML path for AI CLI here
`}
        </pre>
      </div>
    </aside>
  );
}
