import { Component } from 'react';
import { ErrorNote } from './ErrorNote';

// A render error inside a panel shows a message instead of blanking the whole pane.
// Changing `resetKey` (for example the selected incident id) clears the error.
export class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidUpdate(prev) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <ErrorNote>Something went wrong showing this panel. Reload the page to try again.</ErrorNote>;
  }
}
