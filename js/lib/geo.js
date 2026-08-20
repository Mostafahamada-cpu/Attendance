// Geolocation helpers for the attendance geofence.
//
// IMPORTANT: everything here is a CONVENIENCE layer. It gives the user fast,
// clear feedback ("you're 320 m away") and refuses obviously-bad attempts
// before they hit the network — but it is NOT the security boundary. The real
// gate is ta_clock_in / ta_clock_out in db/schema-v2.sql, which recompute the
// distance server-side from ta_settings and reject anything outside the radius.

export const OUTSIDE_MSG =
  'You are outside the allowed attendance area. Please move closer to the attendance location.';

// Fallback centre/radius, used only until ta_settings loads (or if it can't be
// read). Kept in sync with the defaults in db/schema-v2.sql.
export const DEFAULT_GEOFENCE = {
  geofence_lat: 29.979897570225,
  geofence_lng: 31.357097369334436,
  geofence_radius_m: 150,
  max_accuracy_m: 250,
  geofence_enabled: true,
};

export class GeoError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = 'GeoError';
    this.code = code;              // unsupported | insecure | denied | unavailable | timeout
    this.retryable = retryable;
  }
}

// Great-circle distance in metres — identical formula to public.ta_distance_m().
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// '85 m' / '1.4 km'
export function fmtDistance(m) {
  if (m == null || !isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function isSupported() {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

// Geolocation is blocked by browsers on insecure origins (localhost is exempt).
export function isSecureOrigin() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  return ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
}

// 'granted' | 'denied' | 'prompt' | 'unknown' — never throws.
export async function permissionState() {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return s.state || 'unknown';
  } catch (_) { return 'unknown'; }
}

// Resolve to { lat, lng, accuracy, timestamp } or throw a GeoError with a
// message that is already safe to show the user.
export function getPosition({ timeout = 15000, maximumAge = 0, highAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!isSupported()) {
      return reject(new GeoError('unsupported',
        'This device or browser can\'t share a location, so attendance can\'t be verified.', { retryable: false }));
    }
    if (!isSecureOrigin()) {
      return reject(new GeoError('insecure',
        'Location needs a secure (HTTPS) connection. Open the app over HTTPS and try again.', { retryable: false }));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = pos.coords || {};
        if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number' || isNaN(c.latitude) || isNaN(c.longitude)) {
          return reject(new GeoError('unavailable', 'Your device returned an invalid location. Try again in a moment.'));
        }
        resolve({
          lat: c.latitude,
          lng: c.longitude,
          // Some desktop browsers report null accuracy; treat that as "unknown
          // but usable" and let the server decide with its own threshold.
          accuracy: typeof c.accuracy === 'number' && c.accuracy > 0 ? c.accuracy : null,
          timestamp: pos.timestamp || Date.now(),
        });
      },
      (err) => {
        switch (err?.code) {
          case 1: return reject(new GeoError('denied',
            'Location permission is blocked. Allow location access for this site in your browser settings, then try again.',
            { retryable: false }));
          case 2: return reject(new GeoError('unavailable',
            'Location services are unavailable. Turn on GPS / location on your device and try again.'));
          case 3: return reject(new GeoError('timeout',
            'Getting your location took too long. Move somewhere with a clearer sky view and try again.'));
          default: return reject(new GeoError('unavailable',
            err?.message || 'Could not read your location. Please try again.'));
        }
      },
      { enableHighAccuracy: highAccuracy, timeout, maximumAge },
    );
  });
}

// One retry with relaxed options — high-accuracy GPS often times out indoors,
// where the coarse network fix is still good enough to clear a 150 m radius.
export async function getPositionWithFallback(opts = {}) {
  try {
    return await getPosition({ timeout: 12000, maximumAge: 0, highAccuracy: true, ...opts });
  } catch (e) {
    if (e instanceof GeoError && (e.code === 'timeout' || e.code === 'unavailable')) {
      return getPosition({ timeout: 20000, maximumAge: 30000, highAccuracy: false });
    }
    throw e;
  }
}

// Evaluate a fix against a settings row. Mirrors the server's decision so the
// UI can explain it — the server still re-checks and has the final say.
export function evaluate(pos, cfg = DEFAULT_GEOFENCE) {
  const c = { ...DEFAULT_GEOFENCE, ...(cfg || {}) };
  const distance = distanceMeters(pos.lat, pos.lng, c.geofence_lat, c.geofence_lng);
  const radius = c.geofence_radius_m;
  if (!c.geofence_enabled) return { distance, radius, inside: true, reason: 'disabled' };
  if (pos.accuracy != null && pos.accuracy > c.max_accuracy_m) {
    return { distance, radius, inside: false, reason: 'accuracy' };
  }
  return { distance, radius, inside: distance <= radius, reason: distance <= radius ? 'inside' : 'outside' };
}
