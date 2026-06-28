import { Component } from 'react'

/**
 * Last-resort catch for render-time crashes. Without this, one thrown error
 * anywhere in the tree unmounts the whole app to a white screen. Scoped per
 * route (keyed by pathname in App.jsx) so a crash in one page leaves the nav
 * usable and the rest of the app reachable.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Render error:', error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-box" style={{ marginTop: 48 }}>
          <p>Something went wrong rendering this page</p>
          <p className="error-hint">{String(this.state.error?.message || this.state.error)}</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try Again
          </button>
          {' '}
          <button type="button" onClick={() => { window.location.href = '/' }}>
            Go Home
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
