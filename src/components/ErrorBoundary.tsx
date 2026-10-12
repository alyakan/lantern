import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** What the fallback calls the part that broke: "Reload this pane". */
  name?: string;
  /** For the whole window: reloading tries the app again from the start, where a retry would only redraw the same crash. */
  reloadWindow?: boolean;
}

/**
 * Shows a small fallback where a part of the window threw, instead of unmounting everything. Each pane has its own, so
 * the others keep working.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error("A part of the window crashed.", error, info.componentStack);
  }

  private retry = () => {
    if (this.props.reloadWindow) window.location.reload();
    else this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center muted" role="alert">
        <p>
          Something went wrong — <button className="link-button" onClick={this.retry}>Reload this {this.props.name ?? "pane"}</button>
        </p>
      </div>
    );
  }
}
