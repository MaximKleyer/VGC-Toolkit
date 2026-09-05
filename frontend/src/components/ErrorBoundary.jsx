import React from 'react';

/**
 * Catches render errors inside a tab so a bug shows a message with the error
 * text and a retry button instead of unmounting the whole app (blank page).
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('tab crashed', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error);
    return (
      <section className="panel error-boundary">
        <h3 className="panel-title">This tab hit an error</h3>
        <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>{msg}</pre>
        <div className="row">
          <button onClick={() => this.setState({ error: null })}>Try again</button>
          <button onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </section>
    );
  }
}
