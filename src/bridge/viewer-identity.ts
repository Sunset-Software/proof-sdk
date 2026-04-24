/**
 * Stable viewer identity for share-mode sessions.
 *
 * On first call, mints a v4 UUID and persists it in localStorage. Subsequent
 * calls return the same value for the life of the browser profile. Used as
 * the durable target for @-mentions and per-viewer unread state.
 *
 * Clearing localStorage or switching browsers produces a new viewer UUID —
 * this is the intended product behavior for anonymous-by-default collab.
 */
const STORAGE_KEY = 'proof-viewer-id';

let memoryFallbackId: string | null = null;

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older environments: RFC 4122 v4 using crypto.getRandomValues.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readFromStorage(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function writeToStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Private browsing, quota, or disabled storage. The in-memory fallback
    // covers the current session; the viewer will look like a new viewer
    // on every reload, which is acceptable.
  }
}

/**
 * Returns the stable viewer UUID, minting and persisting one on first call.
 */
export function getOrCreateViewerId(): string {
  const existing = readFromStorage();
  if (existing) {
    memoryFallbackId = existing;
    return existing;
  }
  if (memoryFallbackId) return memoryFallbackId;

  const next = generateUUID();
  writeToStorage(next);
  memoryFallbackId = next;
  return next;
}

/**
 * Returns the viewer UUID if one has already been minted, otherwise null.
 * Unlike {@link getOrCreateViewerId}, this never writes.
 */
export function peekViewerId(): string | null {
  return readFromStorage() ?? memoryFallbackId;
}

/**
 * Test-only: reset the in-memory fallback. Does not clear localStorage.
 */
export function __resetViewerIdForTests(): void {
  memoryFallbackId = null;
}
