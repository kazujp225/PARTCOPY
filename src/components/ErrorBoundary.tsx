import React from 'react'

interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2 style={{ color: '#e11d48', marginBottom: 12 }}>エラーが発生しました</h2>
          <p style={{ color: '#64748b', marginBottom: 16 }}>{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: '8px 20px', borderRadius: 6, border: '1px solid #e2e8f0', cursor: 'pointer', background: '#fff' }}
          >
            再試行
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
