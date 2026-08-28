import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { ErrorState } from './ErrorState'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.setState({ error })
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title="Unexpected error"
          message={this.state.error.message}
          requestId="—"
          retriable={false}
        >
          <button className="btn" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </ErrorState>
      )
    }
    return this.props.children
  }
}
