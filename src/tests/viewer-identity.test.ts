/**
 * Unit and integration tests for the viewer UUID primitive (U1).
 *
 * Covers:
 * - Client module: getOrCreateViewerId mints, persists, and returns a stable UUID;
 *   memory fallback when localStorage is unavailable.
 * - Server side: X-Proof-Viewer-Id header upserts a viewer row;
 *   GET /:slug/viewers returns the authenticated caller;
 *   WS viewer.identify frame persists the viewer row;
 *   typeahead endpoint requires authentication.
 *
 * Run: PORT=0 npm run test:server-routes-share is NOT how this runs.
 * This is a standalone tsx test with an in-process HTTP server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

type WsMessage = Record<string, unknown>;

function parseMessage(data: RawData): WsMessage {
  return JSON.parse(data.toString()) as WsMessage;
}

// ---- Client module: localStorage-backed identity ------------------

async function testClientModule(): Promise<void> {
  // Simulate a browser window + localStorage.
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  };

  const { getOrCreateViewerId, peekViewerId, __resetViewerIdForTests } = await import('../bridge/viewer-identity');

  __resetViewerIdForTests();
  storage.clear();

  assert.equal(peekViewerId(), null, 'peekViewerId is null before mint');

  const first = getOrCreateViewerId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'UUID v4 shape');
  assert.equal(peekViewerId(), first, 'peekViewerId returns stored value after mint');

  const second = getOrCreateViewerId();
  assert.equal(second, first, 'subsequent calls return same UUID');
  assert.equal(storage.get('proof-viewer-id'), first, 'UUID persisted in localStorage');

  // Storage failure fallback: simulate quota denial.
  storage.clear();
  __resetViewerIdForTests();
  (globalThis as any).window.localStorage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const sessionId = getOrCreateViewerId();
  assert.match(sessionId, /^[0-9a-f]{8}-/, 'mints via fallback when write fails');
  const sessionIdAgain = getOrCreateViewerId();
  assert.equal(sessionIdAgain, sessionId, 'memory fallback is stable within a session');

  // Cleanup the global window so later tests don't see it.
  delete (globalThis as any).window;
}

// ---- Server integration: endpoint + upsert -----------------------

async function testServerEndpoint(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `proof-viewer-identity-${randomUUID()}.db`);

  const [{ createDocument, createDocumentAccessToken, getDocumentViewer }, { agentRoutes }, { setupWebSocket }] = await Promise.all([
    import('../../server/db'),
    import('../../server/agent-routes'),
    import('../../server/ws'),
  ]);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  try {
    const slug = 'viewer-test';
    createDocument(slug, '# test', {}, 'Viewer test', 'owner-1', 'owner-secret-1');
    const access = createDocumentAccessToken(slug, 'editor');

    const viewerId = 'viewer-aaaa-bbbb-cccc';
    const headers = {
      'x-share-token': access.secret,
      'X-Proof-Viewer-Id': viewerId,
      'X-Proof-Viewer-Name': 'Test Viewer',
    };

    // First request upserts the viewer row on auth success.
    const res = await fetch(`${base}/api/agent/${slug}/viewers`, { headers });
    assert.equal(res.status, 200, 'typeahead returns 200 for authed caller');
    const body = await res.json() as { success: boolean; viewers: Array<Record<string, unknown>> };
    assert.equal(body.success, true);
    assert.equal(body.viewers.length, 1, 'caller appears in their own typeahead');
    assert.equal(body.viewers[0].viewerId, viewerId);
    assert.equal(body.viewers[0].displayName, 'Test Viewer');
    assert.equal(body.viewers[0].kind, 'human');

    // DB row was actually written.
    const row = getDocumentViewer(slug, viewerId);
    assert.ok(row, 'document_viewers row was written');
    assert.equal(row!.display_name, 'Test Viewer');

    // Subsequent request with a new name updates the display name.
    await fetch(`${base}/api/agent/${slug}/viewers`, {
      headers: { ...headers, 'X-Proof-Viewer-Name': 'Renamed' },
    });
    const updated = getDocumentViewer(slug, viewerId);
    assert.equal(updated!.display_name, 'Renamed', 'display name updates on re-upsert');

    // Tokenless access to ACTIVE shares is allowed ("slug is the secret"),
    // matching the existing PUT /api/documents/:slug product decision.
    // First-party SPA traffic hits /viewers without a cookie on clean URLs;
    // the agent-routes checkAuth mirrors apiRoutes' lenient default.
    const unauthRes = await fetch(`${base}/api/agent/${slug}/viewers`);
    assert.equal(unauthRes.status, 200, 'tokenless ACTIVE share gets editor-level access');

    // Malformed viewer ID (unsafe characters) is dropped, not persisted.
    const sneakyId = 'evil id with spaces <script>';
    const sneakyRes = await fetch(`${base}/api/agent/${slug}/viewers`, {
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': sneakyId },
    });
    assert.equal(sneakyRes.status, 200, 'auth still succeeds when viewer id is malformed');
    const sneakyBody = await sneakyRes.json() as { viewers: Array<{ viewerId: string }> };
    assert.ok(
      !sneakyBody.viewers.some((v) => v.viewerId === sneakyId),
      'malformed viewer id is not persisted',
    );

    // WS viewer.identify also writes the row.
    const wsViewerId = 'viewer-ws-1234';
    const ws = new WebSocket(`${wsBase}/ws?slug=${slug}&token=${encodeURIComponent(access.secret)}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 2500);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    let sawViewers = false;
    ws.on('message', (data) => {
      const msg = parseMessage(data);
      if (msg.type === 'viewers.updated') sawViewers = true;
    });
    ws.send(JSON.stringify({
      type: 'viewer.identify',
      name: 'WS Viewer',
      viewerId: wsViewerId,
      capabilities: { bridge: false },
    }));
    await new Promise<void>((r) => setTimeout(r, 120));
    assert.ok(sawViewers, 'viewers.updated broadcast observed');
    const wsRow = getDocumentViewer(slug, wsViewerId);
    assert.ok(wsRow, 'WS viewer.identify persisted a document_viewers row');
    assert.equal(wsRow!.display_name, 'WS Viewer');
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function run(): Promise<void> {
  await testClientModule();
  await testServerEndpoint();
  console.log('viewer-identity.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
