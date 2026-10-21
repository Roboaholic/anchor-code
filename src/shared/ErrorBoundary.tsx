import { Component, type ErrorInfo, type ReactNode } from "react";
import { formatError } from "./formatError";

type Props = {
  children: ReactNode;
  /** Optional label for the fallback heading. */
  label?: string;
};

type State = {
  error: Error | null;
};

/** Themed React error boundary with Retry. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <p className="error-boundary__title">
          {this.props.label ?? "Something went wrong"}
        </p>
        <p className="error-boundary__message muted">{formatError(error)}</p>
        <button
          type="button"
          className="btn btn--fill btn--small"
          onClick={() => this.setState({ error: null })}
        >
          Retry
        </button>
      </div>
    );
  }
}
