/**
 * Tests for U5 — Inbox endpoint and server-tracked unread state.
 *
 * Covers:
 * - GET /:slug/inbox requires X-Proof-Viewer-Id
 * - Fresh viewer sees every thread as unread
 * - POST /threads/:threadId/seen clears a single thread's unread
 * - POST /threads/seen-all bulk-clears every thread
 * - Reply after seen re-flags as unread
 * - `mentioning=<viewerId>` filter returns only threads mentioning that viewer
 * - Forged thread id on /seen returns 404 without writing
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

async function run(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `proof-u5-${randomUUID()}.db`);

  const [{ createDocument, createDocumentAccessToken }, { agentRoutes }] = await Promise.all([
    import('../../server/db'),
    import('../../server/agent-routes'),
  ]);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const slug = 'inbox-test';
    createDocument(slug, '# hi', {}, 'Inbox test', 'owner-1', 'owner-secret-1');
    const access = createDocumentAccessToken(slug, 'editor');
    const viewerA = 'viewer-aaa';
    const viewerB = 'viewer-bbb';

    // Seed two comment threads; one mentions viewerA.
    const c1 = await fetch(`${base}/api/agent/${slug}/marks/comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
        'X-Proof-Viewer-Id': viewerB,
        'X-Proof-Viewer-Name': 'B',
      },
      body: JSON.stringify({
        by: 'human:B',
        quote: 'hi',
        text: '@A take a look',
        mentions: [{ viewerId: viewerA, displayName: 'A', startOffset: 0, endOffset: 2 }],
      }),
    });
    assert.equal(c1.status, 200);
    const mark1Body = await c1.json() as { marks: Record<string, any> };
    const thread1 = Object.keys(mark1Body.marks)[0];

    const c2 = await fetch(`${base}/api/agent/${slug}/marks/comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
        'X-Proof-Viewer-Id': viewerB,
        'X-Proof-Viewer-Name': 'B',
      },
      body: JSON.stringify({ by: 'human:B', quote: 'hi', text: 'second comment' }),
    });
    assert.equal(c2.status, 200);
    const mark2Body = await c2.json() as { marks: Record<string, any> };
    const thread2 = Object.keys(mark2Body.marks).find((id) => id !== thread1)!;

    // Inbox without a viewer id returns 400.
    const missingViewerRes = await fetch(`${base}/api/agent/${slug}/inbox`, {
      headers: { 'x-share-token': access.secret },
    });
    assert.equal(missingViewerRes.status, 400);

    // viewerA sees 2 unread threads; one mentions them.
    const inboxA1 = await fetch(`${base}/api/agent/${slug}/inbox`, {
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA },
    });
    assert.equal(inboxA1.status, 200);
    const inboxA1Body = await inboxA1.json() as { threads: any[]; unreadCount: number };
    assert.equal(inboxA1Body.unreadCount, 2);
    assert.equal(inboxA1Body.threads.length, 2);
    const mentionThread = inboxA1Body.threads.find((t: any) => t.threadId === thread1);
    assert.ok(mentionThread?.mentionsMe, 'mention thread flagged mentionsMe=true');
    const otherThread = inboxA1Body.threads.find((t: any) => t.threadId === thread2);
    assert.equal(otherThread?.mentionsMe, false);

    // Mark thread1 as seen.
    const seenRes = await fetch(`${base}/api/agent/${slug}/threads/${thread1}/seen`, {
      method: 'POST',
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA },
    });
    assert.equal(seenRes.status, 200);

    // Now viewerA has 1 unread.
    const inboxA2 = await fetch(`${base}/api/agent/${slug}/inbox`, {
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA },
    });
    const inboxA2Body = await inboxA2.json() as { threads: any[]; unreadCount: number };
    assert.equal(inboxA2Body.unreadCount, 1);
    const t1After = inboxA2Body.threads.find((t: any) => t.threadId === thread1);
    assert.equal(t1After?.unread, false, 'thread1 now read');

    // Reply on thread1 bumps it back to unread for viewerA.
    await fetch(`${base}/api/agent/${slug}/marks/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
        'X-Proof-Viewer-Id': viewerB,
      },
      body: JSON.stringify({ markId: thread1, by: 'human:B', text: 'follow-up' }),
    });
    const inboxA3 = await fetch(`${base}/api/agent/${slug}/inbox`, {
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA },
    });
    const inboxA3Body = await inboxA3.json() as { threads: any[]; unreadCount: number };
    assert.equal(inboxA3Body.unreadCount, 2, 'new reply pushes thread1 back to unread');

    // Mentioning filter.
    const filterRes = await fetch(
      `${base}/api/agent/${slug}/inbox?mentioning=${encodeURIComponent(viewerA)}`,
      { headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA } },
    );
    const filterBody = await filterRes.json() as { threads: any[] };
    assert.equal(filterBody.threads.length, 1, 'mentioning=viewerA returns only the one thread mentioning A');
    assert.equal(filterBody.threads[0].threadId, thread1);

    // Mark all seen for viewerA.
    const markAllRes = await fetch(`${base}/api/agent/${slug}/threads/seen-all`, {
      method: 'POST',
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA },
    });
    assert.equal(markAllRes.status, 200);
    const markAllBody = await markAllRes.json() as { marked: number };
    assert.equal(markAllBody.marked, 2, 'two threads marked seen');

    const inboxA4 = await fetch(`${base}/api/agent/${slug}/inbox`, {
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA },
    });
    const inboxA4Body = await inboxA4.json() as { unreadCount: number };
    assert.equal(inboxA4Body.unreadCount, 0);

    // Forged thread id returns 404, no write.
    const forgedRes = await fetch(`${base}/api/agent/${slug}/threads/does-not-exist/seen`, {
      method: 'POST',
      headers: { 'x-share-token': access.secret, 'X-Proof-Viewer-Id': viewerA },
    });
    assert.equal(forgedRes.status, 404);

    console.log('inbox-unread.test.ts passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
