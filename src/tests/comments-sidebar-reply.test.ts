/**
 * Tests for U3 — inline reply wiring.
 *
 * Scope note: the visual composer is pure DOM and is exercised in browser
 * smoke tests. This file covers the non-DOM contract that U3 relies on:
 * - shareClient.postCommentReply posts to the correct endpoint with the
 *   expected body shape, auth headers, and X-Proof-Viewer-Id.
 * - Error and empty-input paths return the expected shapes so the
 *   sidebar's composer renders them as inline errors without crashing.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

async function testEmptyInputsReturnNull(): Promise<void> {
  // Stub window/localStorage so the share-client module can load.
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    location: { pathname: '/d/test-slug', search: '', origin: 'http://localhost:4000' },
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  };

  const mod = await import('../bridge/share-client');
  const { ShareClient } = mod;
  const client = new ShareClient();
  (client as any).slug = 'test-slug';

  // Empty markId, empty author, empty text each resolve to null.
  assert.equal(await client.postCommentReply('', 'human:x', 'text'), null);
  assert.equal(await client.postCommentReply('m1', '', 'text'), null);
  assert.equal(await client.postCommentReply('m1', 'human:x', '   '), null);

  delete (globalThis as any).window;
}

async function testHappyPathHitsCorrectEndpoint(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `proof-u3-${randomUUID()}.db`);

  const [{ createDocument, createDocumentAccessToken }, { agentRoutes }] = await Promise.all([
    import('../../server/db'),
    import('../../server/agent-routes'),
  ]);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Capture the incoming request for assertions.
  let captured: {
    path: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } | null = null;

  app.use('/api/agent', (req, _res, next) => {
    if (req.method === 'POST' && /\/marks\/reply$/.test(req.path)) {
      captured = {
        path: req.path,
        method: req.method,
        headers: { ...req.headers } as Record<string, string>,
        body: { ...(req.body as Record<string, unknown>) },
      };
    }
    next();
  });
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // Set up an existing document + a comment mark that the reply targets.
    const slug = 'reply-test';
    createDocument(slug, '# hi', {}, 'Reply test', 'owner-1', 'owner-secret-1');
    const access = createDocumentAccessToken(slug, 'editor');

    // First create a comment so the reply has a target.
    const commentRes = await fetch(`${base}/api/agent/${slug}/marks/comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
      },
      body: JSON.stringify({ by: 'human:Initial', quote: 'hi', text: 'first comment' }),
    });
    assert.equal(commentRes.status, 200, 'seed comment posted');
    const commentBody = await commentRes.json() as { marks?: Record<string, unknown> };
    const markId = Object.keys(commentBody.marks ?? {})[0];
    assert.ok(markId, 'comment mark id present');

    // Now stub window + globalThis.fetch and exercise shareClient.postCommentReply.
    const storage = new Map<string, string>([['proof-viewer-id', 'test-viewer-uuid']]);
    (globalThis as any).window = {
      location: { pathname: `/d/${slug}`, search: '', origin: base },
      localStorage: {
        getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
    };

    const { ShareClient } = await import('../bridge/share-client');
    const client = new ShareClient();
    (client as any).slug = slug;
    (client as any).shareToken = access.secret;
    (client as any).apiOriginOverride = base;

    const result = await client.postCommentReply(markId, 'human:Replier', 'This is the reply.');
    assert.ok(result, 'non-null result');
    if (result && 'error' in result) {
      throw new Error(`Expected success, got error: ${JSON.stringify(result.error)}`);
    }
    assert.equal(result!.success, true, 'reply succeeded');

    // Verify the capture.
    assert.ok(captured, 'request captured');
    assert.equal(captured!.path, `/${slug}/marks/reply`);
    assert.equal(captured!.method, 'POST');
    assert.equal(captured!.headers['x-share-token'], access.secret);
    assert.equal(captured!.headers['x-proof-viewer-id'], 'test-viewer-uuid');
    assert.equal(captured!.body.markId, markId);
    assert.equal(captured!.body.by, 'human:Replier');
    assert.equal(captured!.body.text, 'This is the reply.');

    delete (globalThis as any).window;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function run(): Promise<void> {
  await testEmptyInputsReturnNull();
  await testHappyPathHitsCorrectEndpoint();
  console.log('comments-sidebar-reply.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
