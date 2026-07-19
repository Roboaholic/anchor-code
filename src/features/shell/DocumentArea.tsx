export function DocumentArea() {
  return (
    <section className="document-area">
      <div className="tabs" role="tablist" aria-label="Open items">
        <div className="tab is-active" role="tab" aria-selected>
          <span className="tab__icon" aria-hidden>
            ✦
          </span>
          <span className="tab__label">Welcome</span>
          <button type="button" className="tab__close" aria-label="Close" disabled>
            ×
          </button>
        </div>
        <button type="button" className="tab tab--add" aria-label="New tab" disabled>
          +
        </button>
      </div>

      <div className="document-area__content">
        <article className="welcome">
          <h1 className="welcome__title">Anchor Code</h1>
          <p className="welcome__lead">
            Human-in-the-loop workbench for{" "}
            <strong>auditing AI coding output</strong> and feeding structured
            feedback back to AI CLIs — not a general-purpose IDE.
          </p>

          <ol className="welcome__steps">
            <li>
              <strong>Read</strong> — open a workspace, review code and Markdown
              (Slice 2).
            </li>
            <li>
              <strong>Compare</strong> — pick two commits in History, open a
              diff (Slice 3).
            </li>
            <li>
              <strong>Annotate</strong> — selection comments → session YAML
              (Slice 4).
            </li>
            <li>
              <strong>Hand off</strong> — copy the YAML path into the terminal
              for your AI CLI (Slice 5).
            </li>
          </ol>

          <p className="welcome__meta">
            Slice 1: shell layout + Local host / IPC skeleton. Use{" "}
            <em>Toggle Terminal</em> to show or hide the right panel.
          </p>
        </article>
      </div>
    </section>
  );
}
