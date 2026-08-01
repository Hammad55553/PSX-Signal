import React from 'react';

export const SparklineChart = ({ chartData, maxPrice, minPrice, chartColor, chartGradientId, areaPathStr, linePointsStr, width, height }) => {
  if (!chartData || chartData.length === 0) {
    return (
      <div className="chart-empty" style={{ height: '150px', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '0.85rem', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.01)', border: '1px dashed var(--border-color)', borderRadius: '12px' }}>
        No intraday chart data available.
      </div>
    );
  }

  return (
    <div className="sparkline-container" style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '1rem', marginBottom: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', fontSize: '0.85rem' }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>📈 Live Intraday Sparkline Area Chart</span>
        <span style={{ background: '#f1f5f9', border: '1px solid rgba(15, 23, 42, 0.08)', color: 'var(--text-secondary)', padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600 }}>
          High: Rs. {maxPrice.toFixed(2)} | Low: Rs. {minPrice.toFixed(2)}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <defs>
          <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-buy)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--color-buy)" stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id="redGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-sell)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--color-sell)" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <path d={areaPathStr} fill={`url(#${chartGradientId})`} />
        <polyline
          fill="none"
          stroke={chartColor}
          strokeWidth="2.5"
          points={linePointsStr}
        />
      </svg>
    </div>
  );
};
