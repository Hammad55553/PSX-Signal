import React from 'react';

export const SpeedometerGauge = ({ signal, buyScore, sellScore }) => {
  // Speedometer ranges from -100 (Strong Sell) to 100 (Strong Buy)
  // Calculate value: buyScore is 0-3, sellScore is 0-3.
  let value = 0; // Neutral
  if (signal === 'BUY') {
    value = buyScore ? (buyScore / 3) * 100 : 50;
  } else if (signal === 'SELL') {
    value = sellScore ? -(sellScore / 3) * 100 : -50;
  }

  // Map -100 to 100 range to -90 to 90 degrees
  const angle = (value / 100) * 90;

  // Gauge colors
  const getGaugeColor = () => {
    if (value > 20) return '#10b981'; // Green
    if (value < -20) return '#ef4444'; // Red
    return '#f59e0b'; // Amber/Yellow
  };

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid var(--border-color)',
      borderRadius: '16px',
      padding: '1.5rem',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: '2rem',
      boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)'
    }}>
      <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '1rem' }}>
        🚀 Market Sentiment Meter
      </h4>
      
      {/* Gauge SVG */}
      <div style={{ position: 'relative', width: '200px', height: '110px', overflow: 'hidden' }}>
        <svg width="200" height="200" viewBox="0 0 200 200">
          {/* Background Arc */}
          <path
            d="M 20 100 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="16"
            strokeLinecap="round"
          />
          {/* Sell Zone (Red) */}
          <path
            d="M 20 100 A 80 80 0 0 1 73 40"
            fill="none"
            stroke="#ef4444"
            strokeWidth="16"
            strokeOpacity="0.4"
          />
          {/* Neutral Zone (Orange) */}
          <path
            d="M 73 40 A 80 80 0 0 1 127 40"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="16"
            strokeOpacity="0.4"
          />
          {/* Buy Zone (Green) */}
          <path
            d="M 127 40 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="#10b981"
            strokeWidth="16"
            strokeOpacity="0.4"
          />

          {/* Needle Pin */}
          <circle cx="100" cy="100" r="8" fill="#1e293b" />

          {/* Needle */}
          <line
            x1="100"
            y1="100"
            x2="100"
            y2="35"
            stroke="#1e293b"
            strokeWidth="4"
            strokeLinecap="round"
            transform={`rotate(${angle} 100 100)`}
            style={{ transition: 'transform 0.8s cubic-bezier(0.4, 0, 0.2, 1)' }}
          />
        </svg>
      </div>

      {/* Meter text details */}
      <div style={{ textAlign: 'center', marginTop: '-10px' }}>
        <div style={{
          fontSize: '1.4rem',
          fontWeight: 800,
          color: getGaugeColor(),
          textTransform: 'uppercase',
          letterSpacing: '0.02em'
        }}>
          {signal === 'HOLD' ? 'Neutral' : signal}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
          {value > 20 ? 'Strong Bullish pressure detected' : value < -20 ? 'Bearish momentum dominant' : 'Sideways market movement'}
        </div>
      </div>
    </div>
  );
};
