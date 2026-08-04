import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, AreaSeries, CrosshairMode } from 'lightweight-charts';

/**
 * Area view of the close price, on the same charting engine as the candles so
 * the two tabs share crosshair behaviour, scales and theming.
 */

/** Same outlier guard as the candle chart — one bad bar must not set the scale. */
function sanitize(raw) {
  const closes = raw.map((d) => d.close).filter((c) => c > 0).sort((a, b) => a - b);
  if (closes.length === 0) return [];
  const median = closes[Math.floor(closes.length / 2)];
  return raw.filter(
    (d) => Number.isFinite(d.close) && d.close >= median / 5 && d.close <= median * 5,
  );
}

export const SparklineChart = ({ chartData, loading = false }) => {
  const holderRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [readout, setReadout] = useState(null);

  const data = useMemo(() => {
    if (!chartData || chartData.length < 2) return [];
    return sanitize(chartData).slice(-90);
  }, [chartData]);

  const up = data.length > 1 && data[data.length - 1].close >= data[0].close;

  useEffect(() => {
    if (!holderRef.current) return undefined;
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => (cs.getPropertyValue(n) || f).trim();
    const text = v('--text-muted', '#94a3b8');
    const grid = v('--border-color', '#e5e9f0');
    const accent = v('--accent', '#6366f1');

    const chart = createChart(holderRef.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: grid, style: 1 },
        horzLines: { color: grid, style: 1 },
      },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: grid, timeVisible: false, rightOffset: 2 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: text, width: 1, style: 3, labelBackgroundColor: accent },
        horzLine: { color: text, width: 1, style: 3, labelBackgroundColor: accent },
      },
    });

    const series = chart.addSeries(AreaSeries, { lineWidth: 2 });

    chart.subscribeCrosshairMove((param) => {
      const point = param.seriesData?.get(series);
      setReadout(point ?? null);
    });

    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => (cs.getPropertyValue(n) || f).trim();
    const tone = up ? v('--color-buy', '#10b981') : v('--color-sell', '#ef4444');

    seriesRef.current.applyOptions({
      lineColor: tone,
      topColor: `${tone}55`,
      bottomColor: `${tone}05`,
    });
    seriesRef.current.setData(
      data.map((d) => ({ time: Math.floor(d.time), value: d.close })),
    );
    chartRef.current.timeScale().fitContent();
  }, [data, up]);

  // Same rule as the candle chart: the container stays mounted so the
  // create-once effect always has a real element to render into.
  const busy = loading;
  const noData = !loading && data.length < 2;

  const changePct = data.length > 1
    ? ((data[data.length - 1].close - data[0].close) / data[0].close) * 100
    : 0;
  const shown = readout?.value ?? data[data.length - 1]?.close;

  return (
    <div className="chart-card">
      <div className="chart-header">
        <div className="chart-title-block">
          <span className="chart-title">
            Close price{data.length ? ` · ${data.length} sessions` : ''}
          </span>
          {data.length > 1 && (
            <span className={`chart-change ${up ? 'up' : 'down'}`}>
              {up ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}%
            </span>
          )}
        </div>
        {shown != null && (
          <div className="spark-readout">
            <strong>Rs. {shown.toFixed(2)}</strong>
          </div>
        )}
      </div>

      <div className="chart-stage">
        <div ref={holderRef} className="tv-chart" />
        {busy && (
          <div className="chart-overlay">
            <div className="skeleton-line" />
            <span className="chart-skeleton-label">Loading price series…</span>
          </div>
        )}
        {noData && (
          <div className="chart-overlay">
            <span className="chart-skeleton-label">Not enough price history to plot.</span>
          </div>
        )}
      </div>
    </div>
  );
};
