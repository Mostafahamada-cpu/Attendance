// Supabase Storage access for leave attachments (medical certificates etc.).
//
// The bucket is PRIVATE. Files live under `<employee_uuid>/…` so ownership is
// derived from the path, and storage RLS (db/schema-v3.sql) lets an employee
// read only their own folder while managers and admins can read all of them.
// Viewing always goes through a short-lived signed URL — no public links.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../config.js?v=20260830a';
import { getSession } from './supabase.js?v=20260830a';

export const BUCKET = 'ta-leave-files';
export const MAX_BYTES = 5 * 1024 * 1024;          // must match the bucket limit
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/heic,application/pdf';
const ALLOWED = ACCEPT.split(',');

const API = () => SUPABASE_URL + '/storage/v1';

function authHeaders() {
  const s = getSession();
  return {
    apikey: SUPABASE_ANON_KEY,
    ...(s?.access_token ? { Authorization: 'Bearer ' + s.access_token } : {}),
  };
}

export function validateFile(file) {
  if (!file) return 'No file selected.';
  if (file.size > MAX_BYTES) {
    return `That file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB.`;
  }
  if (file.type && !ALLOWED.includes(file.type)) {
    return 'Attach a PDF or an image (PNG, JPEG, WebP or HEIC).';
  }
  return null;
}

// Strip anything that could confuse a path, keep it recognisable.
function safeName(name) {
  return (name || 'file')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .slice(-80) || 'file';
}

// Uploads and resolves to { path, name }. Throws with a readable message.
export async function uploadLeaveAttachment(file, employeeId) {
  const bad = validateFile(file);
  if (bad) throw new Error(bad);
  if (!employeeId) throw new Error('Not signed in.');

  const path = `${employeeId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName(file.name)}`;
  const res = await fetch(`${API()}/object/${BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' },
    body: file,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.message || err.error || `HTTP ${res.status}`;
    if (/bucket not found/i.test(msg)) {
      throw new Error('Attachment storage is not set up yet — ask your admin to run db/schema-v3.sql. You can still submit without a file.');
    }
    throw new Error('Upload failed: ' + msg);
  }
  return { path, name: file.name };
}

// Short-lived signed URL for viewing an attachment, or null if unavailable.
export async function signedUrl(path, expiresIn = 300) {
  if (!path) return null;
  try {
    const res = await fetch(`${API()}/object/sign/${BUCKET}/${encodeURI(path)}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.signedURL ? API() + d.signedURL : null;
  } catch (_) { return null; }
}

// True when the bucket exists and is reachable for this user, so the UI can
// hide the attachment field on an installation that skipped the bucket setup.
let _available = null;
export async function attachmentsAvailable() {
  if (_available !== null) return _available;
  try {
    const res = await fetch(`${API()}/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1 }),
    });
    _available = res.ok;
  } catch (_) { _available = false; }
  return _available;
}
