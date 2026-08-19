import ErrorBoundary from './components/ErrorBoundary'
import OpeningsExplorer from './OpeningsExplorer'
import './styles/shell.css'
import './openings.css'

export default function OpeningsApp() {
  return (
    <div className="app">
      <div className="cr2 openings-app">
        <nav className="nav2">
          <a href="/" className="nav2-brand">
            <span className="nav2-logo">♞</span> Chess Openings
          </a>
        </nav>
        <main className="openings-main">
          <ErrorBoundary>
            <OpeningsExplorer />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
