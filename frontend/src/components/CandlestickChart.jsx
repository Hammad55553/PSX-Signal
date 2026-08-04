import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
} from 'lightweight-charts';

/**
 * Price chart built on TradingView's lightweight-charts.
 *
 * Replaces a hand-rolled SVG chart. The library handles the things that are
 * tedious and easy to get subtly wrong by hand — pixel-snapped crosshair,
 * autoscaling that ignores the visible-range edges correctly, pinch/wheel
 * zoom, and a price scale that stays readable at any zoom level.
 *
 * Bars are still validated here: the upstream feed has shipped a bar with a
 * high 5x the real price, and while the backend now filters those, a chart
 * should not assume its input is clean.
 */

const RANGES = [
  { label: '1M', bars: 22 },
  { label: '3M', bars: 66 },
  { label: '6M', bars: 132 },
  { label: 'All', bars: Infinity },
];

/** Reject bars that cannot be real, so one bad point cannot wreck the scale. */
function sanitize(raw) {
  const closes = raw.map((d) => d.close).filter((c) => c > 0).sort((a, b) => a - b);
  if (closes.length === 0) return [];
  const median = closes[Math.floor(closes.length / 2)];
  const lo = median / 5;
  const hi = median * 5;

  return raw.filter((d) =>
    [d.open, d.high, d.low, d.close].every(
      (v) => Number.isFinite(v) && v >= lo && v <= hi,
    ) && d.high >= d.low,
  );
}

const toBar = (d) => ({
  time: Math.floor(d.time),
  open: d.open,
  high: d.high,
  low: d.low,
  close: d.close,
});

export const CandlestickChart = ({ chartData, loadingChart }) => {
  const holderRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeRef = useRef(null);
  const maRef = useRef(null);
  const [rangeIdx, setRangeIdx] = useState(1);
  const [readout, setReadout] = useState(null);

  const clean = useMemo(
    () => (chartData && chartData.length ? sanitize(chartData) : []),
    [chartData],
  );

  const visible = useMemo(() => {
    const n = RANGES[rangeIdx].bars;
    return n === Infinity ? clean : clean.slice(-n);
  }, [clean, rangeIdx]);

  // Read theme colours from CSS custom properties so the chart follows the
  // app's light/dark tokens instead of hard-coding a second palette.
  const themeOf = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fallback) => (cs.getPropertyValue(n) || fallback).trim();
    return {
      text: v('--text-muted', '#94a3b8'),
      grid: v('--border-color', '#e5e9f0'),
      up: v('--color-buy', '#10b981'),
      down: v('--color-sell', '#ef4444'),
      accent: v('--accent', '#6366f1'),
    };
  };

  // Create the chart once.
  useEffect(() => {
    if (!holderRef.current) return undefined;
    const t = themeOf();

    const chart = createChart(holderRef.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: t.text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: t.grid, style: 1 },
        horzLines: { color: t.grid, style: 1 },
      },
      rightPriceScale: { borderColor: t.grid, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: t.grid, timeVisible: false, rightOffset: 4 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: t.text, width: 1, style: 3, labelBackgroundColor: t.accent },
        horzLine: { color: t.text, width: 1, style: 3, labelBackgroundColor: t.accent },
      },
      handleScale: { axisPressedMouseMove: { price: false } },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      borderUpColor: t.up,
      borderDownColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    // Pin volume to the bottom quarter so it never fights the price series.
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const ma = chart.addSeries(LineSeries, {
      color: t.accent,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData?.get(candles);
      setReadout(bar ?? null);
    });

    chartRef.current = chart;
    seriesRef.current = candles;
    volumeRef.current = volume;
    maRef.current = ma;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Feed data whenever the visible slice changes.
  useEffect(() => {
    if (!seriesRef.current || visible.length === 0) return;
    const t = themeOf();

    seriesRef.current.setData(visible.map(toBar));

    volumeRef.current.setData(
      visible.map((d) => ({
        time: Math.floor(d.time),
        value: d.volume || 0,
        color: d.close >= d.open ? `${t.up}44` : `${t.down}44`,
      })),
    );

    // 20-period MA, only where a full window exists.
    const closes = visible.map((d) => d.close);
    const period = 20;
    const maData = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i += 1) {
      sum += closes[i];
      if (i >= period) sum -= closes[i - period];
      if (i >= period - 1) {
        maData.push({ time: Math.floor(visible[i].time), value: sum / period });
      }
    }
    maRef.current.setData(maData);

    chartRef.current.timeScale().fitContent();
  }, [visible]);

  // The chart container must stay mounted at all times. Returning a skeleton
  // instead of it meant the ref was null when the create-once effect ran, the
  // effect never re-ran (empty deps), and the chart silently never appeared.
  // Loading and empty states are drawn OVER the container instead.
  const busy = loadingChart;
  const noData = !loadingChart && clean.length === 0;

  const first = visible[0];
  const last = visible[visible.length - 1];
  const changePct = first ? ((last.close - first.close) / first.close) * 100 : 0;
  const shown = readout ?? last;
  const dropped = (chartData?.length ?? 0) - clean.length;

  return (
    <div className="chart-card">
      <div className="chart-header">
        <div className="chart-title-block">
          <span className="chart-title">Price history</span>
          {last && (
            <span className={`chart-change ${changePct >= 0 ? 'up' : 'down'}`}>
              {changePct >= 0 ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}% over {RANGES[rangeIdx].label}
            </span>
          )}
        </div>
        <div className="range-picker">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              className={`range-btn ${i === rangeIdx ? 'active' : ''}`}
              onClick={() => setRangeIdx(i)}
              disabled={busy || noData}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {shown && (
        <div className="ohlc-strip">
          <span>O <strong>{shown.open?.toFixed(2)}</strong></span>
          <span>H <strong className="up">{shown.high?.toFixed(2)}</strong></span>
          <span>L <strong className="down">{shown.low?.toFixed(2)}</strong></span>
          <span>C <strong>{shown.close?.toFixed(2)}</strong></span>
          <span className="chart-legend-ma">— 20-day MA</span>
        </div>
      )}

      <div className="chart-stage">
        <div ref={holderRef} className="tv-chart" />

        {busy && (
          <div className="chart-overlay">
            <div className="skeleton-bars">
              {Array.from({ length: 28 }, (_, i) => (
                <span key={i} style={{ animationDelay: `${i * 45}ms`, height: `${25 + ((i * 37) % 60)}%` }} />
              ))}
            </div>
            <span className="chart-skeleton-label">Loading price history…</span>
          </div>
        )}

        {noData && (
          <div className="chart-overlay">
            <span className="chart-skeleton-label">No usable price history for this symbol.</span>
          </div>
        )}
      </div>

      {dropped > 0 && (
        <div className="chart-note">
          {dropped} corrupt bar{dropped > 1 ? 's' : ''} from the data feed excluded.
        </div>
      )}
    </div>
  );
};
