// Date / time / duration helpers. All local-time based.

export const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' for a Date in LOCAL time (not UTC — avoids off-by-one).
export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayYMD() { return ymd(new Date()); }

// '09:45 AM'
export function fmtTime(dtLike) {
  if (!dtLike) return '--:--';
  const d = new Date(dtLike);
  if (isNaN(d)) return '--:--';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
// '09:45' 24h short
export function fmtHM(dtLike) {
  if (!dtLike) return '--:--';
  const d = new Date(dtLike);
  if (isNaN(d)) return '--:--';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 'Thursday, August 13, 2026'
export function fmtLongDate(d = new Date()) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
// 'Aug 13, 2026' — accepts Date or 'YYYY-MM-DD'
export function fmtShortDate(dLike) {
  const d = typeof dLike === 'string' ? new Date(dLike + 'T00:00:00') : dLike;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
// 'Aug 13'
export function fmtDayMon(dLike) {
  const d = typeof dLike === 'string' ? new Date(dLike + 'T00:00:00') : dLike;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// minutes -> 'HH:MM'
export function minToHM(min) {
  min = Math.max(0, Math.round(min || 0));
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
// minutes -> '04h 35m'
export function minToDur(min) {
  min = Math.max(0, Math.round(min || 0));
  return `${pad(Math.floor(min / 60))}h ${pad(min % 60)}m`;
}
// minutes -> '9.3h'
export function minToHoursDec(min) { return (Math.max(0, min || 0) / 60).toFixed(1) + 'h'; }

// whole days inclusive between two YYYY-MM-DD
export function daysBetween(start, end) {
  const a = new Date(start + 'T00:00:00'), b = new Date(end + 'T00:00:00');
  return Math.floor((b - a) / 86400000) + 1;
}

// relative 'time ago'
export function ago(dtLike) {
  const s = Math.floor((Date.now() - new Date(dtLike)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return fmtShortDate(new Date(dtLike));
}

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
