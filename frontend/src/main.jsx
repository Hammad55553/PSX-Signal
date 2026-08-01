import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('PSX Dashboard crashed:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Outfit, sans-serif',
          background: '#f8fafc',
          padding: '2rem',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: '#1e3a8a', marginBottom: '0.5rem' }}>PSX Dashboard Error</h2>
          <p style={{ color: '#64748b', maxWidth: '480px', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              padding: '0.65rem 1.5rem',
              fontFamily: 'Outfit, sans-serif',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: '0.9rem'
            }}
          >
            Reload Dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
