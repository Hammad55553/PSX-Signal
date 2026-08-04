/**
 * Desktop notifications for signal changes.
 *
 * Two rules drive everything here:
 *
 *  1. Only genuine TRANSITIONS notify. The scan re-runs on a timer and a stock
 *     that has been BUY all morning is not news — notifying every cycle is how
 *     an alert feed becomes something people mute.
 *  2. The same transition never fires twice, even across reconnects and page
 *     reloads, because the WebSocket redelivers full state on every connect.
 */

const SEEN_KEY = 'psx_notified_v1';
const SEEN_TTL_MS = 12 * 60 * 60 * 1000; // a signal is stale news after a session

function loadSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
    const cutoff = Date.now() - SEEN_TTL_MS;
    return Object.fromEntries(Object.entries(raw).filter(([, t]) => t > cutoff));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* private mode / quota — notifications still work, just not deduped */
  }
}

/** Short beep via WebAudio. No asset to ship, and no autoplay-blocked <audio>. */
function beep(kind = 'buy') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    // Rising tone for BUY, falling for SELL — distinguishable without looking.
    const [from, to] = kind === 'buy' ? [520, 780] : [520, 320];
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => ctx.close();
  } catch {
    /* audio unavailable — silent is fine */
  }
}

export const notify = {
  supported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  },

  permission() {
    return this.supported() ? Notification.permission : 'unsupported';
  },

  async request() {
    if (!this.supported()) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  },

  /**
   * Decide which signals in a scan are newly actionable.
   *
   * @param {Array}  results  latest scan
   * @param {Object} previous ticker -> previous signal object
   * @returns {Array} transitions worth telling the user about
   */
  findTransitions(results, previous) {
    const out = [];
    for (const sig of results) {
      const prev = previous[sig.ticker];
      if (!prev) continue; // first sight of a ticker is not a transition

      const changed = prev.signal !== sig.signal;
      // A HOLD that firms up into high conviction is worth surfacing even
      // though the label did not change.
      const upgraded =
        !changed && !prev.high_conviction && sig.high_conviction;

      if ((changed && sig.signal !== 'HOLD') || upgraded) {
        out.push(sig);
      }
    }
    return out;
  },

  /**
   * Fire a desktop notification for one signal, unless already sent.
   * @returns {boolean} whether a notification was actually shown
   */
  send(sig) {
    if (!this.supported() || Notification.permission !== 'granted') return false;

    // Key on the state being announced, not the time — reconnects redeliver
    // the same state and must not re-alert.
    const key = `${sig.ticker}:${sig.signal}:${sig.high_conviction ? 'hc' : 'n'}:${sig.updated_at}`;
    const seen = loadSeen();
    if (seen[key]) return false;

    const symbol = sig.symbol || sig.ticker.replace('.KA', '');
    const isBuy = sig.signal === 'BUY';
    const conviction = sig.high_conviction ? 'HIGH CONVICTION ' : '';

    const title = isBuy
      ? `${conviction}BUY ${symbol} — Rs. ${sig.current_price}`
      : `EXIT ${symbol} — Rs. ${sig.current_price}`;

    const body = isBuy
      ? `Confidence ${Math.round(sig.confidence)}%  ·  target Rs. ${sig.target}  ·  stop Rs. ${sig.stop_loss}\n` +
        `Hold ${sig.hold_sessions} sessions.`
      : `Confidence ${Math.round(sig.confidence)}%  ·  close longs near Rs. ${sig.current_price}.\n` +
        `Exit signal only — not a short.`;

    try {
      const n = new Notification(title, {
        body,
        tag: `psx-${sig.ticker}`, // replaces an older alert for the same stock
        requireInteraction: !!sig.high_conviction,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      return false;
    }

    beep(isBuy ? 'buy' : 'sell');
    seen[key] = Date.now();
    saveSeen(seen);
    return true;
  },
};
