/**
 * Tests for U6 — live delivery of comment.activity and comment.mentioned
 * events over the WS bus.
 *
 * One tab posts a comment with a mention targeting another tab's viewer.
 * The second tab's WS connection must observe both frames in order to
 * drive live Inbox badge updates.
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

async function run(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `proof-u6-${randomUUID()}.db`);

  const [{ createDocument, createDocumentAccessToken }, { agentRoutes }, { setupWebSocket }] = await Promise.all([
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
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  try {
    const slug = 'live-event-test';
    createDocument(slug, '# hi', {}, 'Live event test', 'owner-1', 'owner-secret-1');
    const access = createDocumentAccessToken(slug, 'editor');

    const viewerA = 'viewer-live-a';
    const viewerB = 'viewer-live-b';

    // Viewer A connects and subscribes. Collect observed messages.
    const observed: WsMessage[] = [];
    const ws = new WebSocket(`${wsBase}/ws?slug=${slug}&token=${encodeURIComponent(access.secret)}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 2000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    ws.on('message', (data) => observed.push(parseMessage(data)));
    ws.send(JSON.stringify({
      type: 'viewer.identify',
      name: 'A',
      viewerId: viewerA,
      capabilities: { bridge: false },
    }));
    await new Promise<void>((r) => setTimeout(r, 80));

    // Viewer B posts a comment that mentions viewerA.
    const c1 = await fetch(`${base}/api/agent/${slug}/marks/comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
        'X-Proof-Viewer-Id': viewerB,
      },
      body: JSON.stringify({
        by: 'human:B',
        quote: 'hi',
        text: '@A check this',
        mentions: [{ viewerId: viewerA, displayName: 'A', startOffset: 0, endOffset: 2 }],
      }),
    });
    assert.equal(c1.status, 200);
    const markId = Object.keys((await c1.json() as { marks: Record<string, any> }).marks)[0];

    // Settle then inspect.
    await new Promise<void>((r) => setTimeout(r, 150));

    const activity = observed.find((m) => m.type === 'comment.activity');
    assert.ok(activity, 'comment.activity broadcast observed by viewer A');
    assert.equal(activity.markId, markId);
    assert.equal(activity.byActor, 'human:B');
    assert.equal(activity.byViewerId, viewerB);

    const mentioned = observed.find((m) => m.type === 'comment.mentioned');
    assert.ok(mentioned, 'comment.mentioned broadcast observed by viewer A');
    const ids = (mentioned.mentionedViewerIds as string[]) || [];
    assert.ok(ids.includes(viewerA));

    // Viewer B posts a plain reply (no mentions). Viewer A should see
    // comment.activity but NOT a second comment.mentioned frame.
    observed.length = 0;
    const r1 = await fetch(`${base}/api/agent/${slug}/marks/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
        'X-Proof-Viewer-Id': viewerB,
      },
      body: JSON.stringify({ markId, by: 'human:B', text: 'plain reply' }),
    });
    assert.equal(r1.status, 200);
    await new Promise<void>((r) => setTimeout(r, 150));

    const activity2 = observed.find((m) => m.type === 'comment.activity');
    assert.ok(activity2, 'activity event for plain reply');
    assert.equal(activity2.replyCount, 1);
    const mentioned2 = observed.find((m) => m.type === 'comment.mentioned');
    assert.equal(mentioned2, undefined, 'no mention event when reply had no mentions');

    ws.close();
    console.log('live-mention-delivery.test.ts passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
