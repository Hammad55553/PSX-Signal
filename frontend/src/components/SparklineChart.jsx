import React, { useState } from 'react';

export const SparklineChart = ({ chartData, maxPrice, minPrice, chartColor, chartGradientId, width, height }) => {
  const [hoveredPoint, setHoveredPoint] = useState(null);

  if (!chartData || chartData.length === 0) {
    return (
      <div className="chart-empty" style={{ height: '150px', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '0.85rem', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.01)', border: '1px dashed var(--border-color)', borderRadius: '12px' }}>
        No intraday chart data available.
      </div>
    );
  }

  // Slice last 40 candles for clean representation
  const activeData = chartData.slice(-40);
  const prices = activeData.map(d => d.close);
  const localMax = Math.max(...prices);
  const localMin = Math.min(...prices);
  const priceDiff = localMax - localMin || 1;
  
  const padding = 15;
  const coordinates = activeData.map((p, idx) => {
    const x = padding + (idx / (activeData.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (p.close - localMin) / priceDiff) * (height - padding * 2);
    return { x, y, price: p.close, index: idx };
  });

  const linePointsStr = coordinates.map(c => `${c.x},${c.y}`).join(' ');
  const areaPathStr = `M ${coordinates[0].x} ${height} ` +
    coordinates.map(c => `L ${c.x} ${c.y}`).join(' ') +
    ` L ${coordinates[coordinates.length - 1].x} ${height} Z`;

  const handleMouseMove = (e) => {
    const svgRect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - svgRect.left;
    
    // Find closest coordinate point by X distance
    let closest = coordinates[0];
    let minDist = Math.abs(coordinates[0].x - (mouseX / svgRect.width) * width);
    
    coordinates.forEach(c => {
      const dist = Math.abs(c.x - (mouseX / svgRect.width) * width);
      if (dist < minDist) {
        minDist = dist;
        closest = c;
      }
    });

    setHoveredPoint(closest);
  };

  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  return (
    <div className="sparkline-container" style={{ background: '#ffffff', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '1.25rem', marginBottom: '2rem', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', fontSize: '0.85rem' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>📈 Live Intraday Sparkline Area Chart</span>
        {hoveredPoint ? (
          <span style={{ background: '#3b82f6', color: '#ffffff', padding: '0.3rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600 }}>
            Hover Price: Rs. {hoveredPoint.price.toFixed(2)}
          </span>
        ) : (
          <span style={{ background: '#f1f5f9', border: '1px solid rgba(15, 23, 42, 0.08)', color: 'var(--text-secondary)', padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600 }}>
            High: Rs. {localMax.toFixed(2)} | Low: Rs. {localMin.toFixed(2)}
          </span>
        )}
      </div>

      <svg 
        viewBox={`0 0 ${width} ${height}`} 
        style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id="redGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        
        {/* Background Grid Lines */}
        <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(0,0,0,0.05)" strokeDasharray="4 4" />
        <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="rgba(0,0,0,0.05)" strokeDasharray="4 4" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(0,0,0,0.05)" strokeDasharray="4 4" />

        <path d={areaPathStr} fill={`url(#${chartGradientId})`} />
        
        <polyline
          fill="none"
          stroke={chartColor}
          strokeWidth="3"
          points={linePointsStr}
        />

        {/* Hover Highlight Marker */}
        {hoveredPoint && (
          <>
            {/* Vertical crosshair line */}
            <line 
              x1={hoveredPoint.x} 
              y1={padding} 
              x2={hoveredPoint.x} 
              y2={height - padding} 
              stroke="#3b82f6" 
              strokeWidth="1.5" 
              strokeDasharray="3 3" 
            />
            {/* Highlight point dot */}
            <circle 
              cx={hoveredPoint.x} 
              cy={hoveredPoint.y} 
              r="6" 
              fill="#3b82f6" 
              stroke="#ffffff" 
              strokeWidth="2" 
            />
          </>
        )}
      </svg>
    </div>
  );
};
