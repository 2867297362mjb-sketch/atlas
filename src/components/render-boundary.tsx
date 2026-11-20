/**
 * Contain a render failure to the part of the window that failed.
 *
 * The only boundary used to be the app's own (`TelemetryErrorBoundary`), so a
 * transcript row that threw on input an agent sent (audit #94) replaced the
 * whole window with the crash screen, and did again every time that session
 * was shown. Around a row or a panel, this draws `fallback` in its place and
 * leaves the rest of the window working. The error still reaches telemetry,
 * as the root boundary reports it.
 *
 * `resetKey`: a new value renders the children again, for content that may
 * have changed into something drawable (the next delta to a row).
 */
import React from "react";
import { captureClientError } from "@/features/telemetry/posthog-client";

interface Props {
  children: React.ReactNode;
  fallback: React.ReactNode;
  /** Where in the window this is, for the report. */
  name: string;
  resetKey?: unknown;
}

interface State {
  failed: boolean;
  /** The `resetKey` the children were last drawn for. */
  key: unknown;
}

export class RenderBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // New content: worth drawing again.
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    captureClientError(error, {
      type: "react_render_boundary",
      boundary: this.props.name,
      component_stack: info.componentStack?.slice(0, 2000),
    });
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
