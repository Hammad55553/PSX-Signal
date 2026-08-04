import React, { useEffect, useState } from 'react';

/**
 * Conviction gauge.
 *
 * Geometry is derived rather than hand-written. The previous version had
 * hard-coded arc endpoints of (73,40) and (127,40) for what were meant to be
 * three equal 60-degree zones; the correct boundaries on an r=80 arc centred
 * at (100,100) are (60, 30.7) and (140, 30.7), so every coloured band was
 * misaligned with the needle it was supposed to describe.
 *
 * It also divided the score by 3 while the engine emits -10..+10, which pinned
 * the needle to the end stop for almost every real signal.
 */

const CX = 100;
const CY = 100;
const R = 78;
const ARC_W = 15;

/** Polar -> cartesian. 180deg = left end of the dial, 0deg = right end. */
function pt(angleDeg, radius = R) {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + radius * Math.cos(a), CY - radius * Math.sin(a)];
}

function arc(fromDeg, toDeg, radius = R) {
  const [x1, y1] = pt(fromDeg, radius);
  const [x2, y2] = pt(toDeg, radius);
  // Always the short way round; every band here is well under 180deg.
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = fromDeg > toDeg ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** score (-10..10) -> dial angle (180deg at -10, 0deg at +10). */
function scoreToAngle(score) {
  const clamped = Math.max(-10, Math.min(10, score || 0));
  return 180 - ((clamped + 10) / 20) * 180;
}

const BANDS = [
  { from: 180, to: 144, color: '#ef4444', label: 'Strong exit' },
  { from: 144, to: 108, color: '#f97316', label: 'Exit' },
  { from: 108, to: 72, color: '#94a3b8', label: 'Neutral' },
  { from: 72, to: 36, color: '#22c55e', label: 'Buy' },
  { from: 36, to: 0, color: '#10b981', label: 'Strong buy' },
];

export const SpeedometerGauge = ({ signal, score = 0, confidence = 0, highConviction = false }) => {
  // Animate from neutral on mount so the needle sweeps into place instead of
  // snapping — the movement is what makes the reading legible.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(score));
    return () => cancelAnimationFrame(id);
  }, [score]);

  const angle = scoreToAngle(shown);
  const [nx, ny] = pt(angle, R - 16);

  const tone =
    signal === 'BUY' ? '#10b981' : signal === 'SELL' ? '#ef4444' : '#94a3b8';
  const verdict =
    signal === 'BUY' ? 'BUY' : signal === 'SELL' ? 'EXIT' : 'NEUTRAL';
  const subtitle =
    signal === 'BUY'
      ? 'Reversion setup is active'
      : signal === 'SELL'
      ? 'Close longs — not a short signal'
      : 'No edge worth trading';

  return (
    <div className="gauge-card">
      <div className="gauge-head">
        <span>Conviction</span>
        {highConviction && <span className="conviction-tag">HIGH</span>}
      </div>

      <div className="gauge-svg-wrap">
        <svg viewBox="0 0 200 128" className="gauge-svg" role="img"
             aria-label={`${verdict}, score ${score.toFixed(1)} of 10, confidence ${Math.round(confidence)} percent`}>
          {/* No blur filters anywhere. An feGaussianBlur glow on the needle
              and the active band made the whole dial read as out of focus —
              contrast and weight carry the emphasis instead. */}

          {/* Track */}
          <path d={arc(180, 0)} fill="none" stroke="var(--gauge-track)"
                strokeWidth={ARC_W} strokeLinecap="round" />

          {/* Coloured bands */}
          {BANDS.map((b) => (
            <path key={b.label} d={arc(b.from, b.to)} fill="none" stroke={b.color}
                  strokeWidth={ARC_W} strokeOpacity="0.28" />
          ))}

          {/* Active band, at full strength */}
          {BANDS.filter((b) => angle <= b.from && angle >= b.to).map((b) => (
            <path key={`${b.label}-active`} d={arc(b.from, b.to)} fill="none"
                  stroke={b.color} strokeWidth={ARC_W + 2} strokeLinecap="round"
                  className="gauge-band-active" />
          ))}

          {/* Ticks every 18deg */}
          {Array.from({ length: 11 }, (_, i) => {
            const a = 180 - i * 18;
            const [x1, y1] = pt(a, R - ARC_W / 2 - 3);
            const [x2, y2] = pt(a, R - ARC_W / 2 - (i % 5 === 0 ? 11 : 7));
            return (
              <line key={a} x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="var(--gauge-tick)" strokeWidth={i % 5 === 0 ? 2 : 1}
                    strokeLinecap="round" />
            );
          })}

          <text x="14" y="120" className="gauge-axis-label">-10</text>
          <text x="100" y="16" className="gauge-axis-label" textAnchor="middle">0</text>
          <text x="186" y="120" className="gauge-axis-label" textAnchor="end">+10</text>

          {/* Needle — tapered via two strokes rather than a filter, so it
              stays sharp at any rendered size. */}
          <g className="gauge-needle">
            <line x1={CX} y1={CY} x2={nx} y2={ny} stroke={tone} strokeWidth="4"
                  strokeLinecap="round" opacity="0.28" />
            <line x1={CX} y1={CY} x2={nx} y2={ny} stroke={tone} strokeWidth="2.2"
                  strokeLinecap="round" />
            <circle cx={CX} cy={CY} r="9" fill="var(--surface)" stroke="var(--gauge-hub)" strokeWidth="2" />
            <circle cx={CX} cy={CY} r="3.5" fill={tone} />
          </g>
        </svg>
      </div>

      <div className="gauge-readout">
        <div className="gauge-verdict" style={{ color: tone }}>{verdict}</div>
        <div className="gauge-score">
          score <strong>{(score ?? 0).toFixed(1)}</strong>
          <span className="gauge-sep">·</span>
          confidence <strong>{Math.round(confidence)}%</strong>
        </div>
        <div className="gauge-subtitle">{subtitle}</div>
      </div>
    </div>
  );
};
