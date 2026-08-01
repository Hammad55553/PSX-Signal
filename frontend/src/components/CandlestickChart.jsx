import React, { useState } from 'react';

export const CandlestickChart = ({ chartData, loadingChart, maxVal, minVal }) => {
  const [hoveredCandle, setHoveredCandle] = useState(null);

  if (loadingChart) {
    return (
      <div className="chart-loader" style={{ height: '220px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', background: '#ffffff', border: '1px solid var(--border-color)', borderRadius: '16px' }}>
        <div className="spinner"></div>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Loading Candlestick chart...</span>
      </div>
    );
  }
  if (!chartData || chartData.length === 0) {
    return (
      <div className="chart-empty" style={{ height: '220px', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '0.85rem', color: 'var(--text-secondary)', background: '#ffffff', border: '1px dashed var(--border-color)', borderRadius: '16px' }}>
        No candlestick chart data available.
      </div>
    );
  }

  const dataSlice = chartData.slice(-40);
  const diff = maxVal - minVal || 1;

  const width = 600;
  const height = 220;
  const padding = 20;
  const chartHeight = height - padding * 2;
  const chartWidth = width - padding * 2;
  const candleWidth = Math.max(3, Math.floor(chartWidth / dataSlice.length) - 4);

  const getY = (val) => padding + (1 - (val - minVal) / diff) * chartHeight;

  return (
    <div className="sparkline-container" style={{ background: '#ffffff', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '1.25rem', marginBottom: '2rem', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', fontSize: '0.85rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>🕯️ Candlestick Trading Chart (Daily History)</span>
        
        {hoveredCandle ? (
          <span style={{ background: '#10b981', color: '#ffffff', padding: '0.3rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600 }}>
            O: {hoveredCandle.open.toFixed(2)} | H: {hoveredCandle.high.toFixed(2)} | L: {hoveredCandle.low.toFixed(2)} | C: {hoveredCandle.close.toFixed(2)}
          </span>
        ) : (
          <span style={{ background: '#f0f7f4', border: '1px solid rgba(16, 185, 129, 0.15)', color: '#047857', padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600 }}>
            High: Rs. {maxVal.toFixed(2)} | Low: Rs. {minVal.toFixed(2)}
          </span>
        )}
      </div>

      <div className="chart-wrapper">
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
            const y = padding + ratio * chartHeight;
            const val = maxVal - ratio * diff;
            return (
              <g key={i}>
                <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="rgba(0,0,0,0.05)" strokeDasharray="3,3" />
                <text x={width - padding + 5} y={y + 4} fontSize="8" fill="#94a3b8" textAnchor="start">
                  {val.toFixed(1)}
                </text>
              </g>
            );
          })}

          {dataSlice.map((candle, idx) => {
            const x = padding + (idx / (dataSlice.length - 1)) * (chartWidth - candleWidth);
            const yOpen = getY(candle.open);
            const yClose = getY(candle.close);
            const yHigh = getY(candle.high);
            const yLow = getY(candle.low);

            const isGreen = candle.close >= candle.open;
            const color = isGreen ? '#10b981' : '#ef4444';

            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(1.5, Math.abs(yOpen - yClose));

            return (
              <g 
                key={idx}
                onMouseEnter={() => setHoveredCandle(candle)}
                onMouseLeave={() => setHoveredCandle(null)}
                style={{ cursor: 'pointer' }}
              >
                {/* Candle Wick */}
                <line x1={x + candleWidth / 2} y1={yHigh} x2={x + candleWidth / 2} y2={yLow} stroke={color} strokeWidth="1.5" />
                {/* Candle Body */}
                <rect
                  x={x}
                  y={bodyTop}
                  width={candleWidth}
                  height={bodyHeight}
                  fill={color}
                  stroke={color}
                  strokeWidth="0.5"
                  rx="1"
                />
                {/* Hover trigger overlay rect */}
                <rect
                  x={x - 2}
                  y={padding}
                  width={candleWidth + 4}
                  height={chartHeight}
                  fill="transparent"
                  style={{ pointerEvents: 'all' }}
                />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
