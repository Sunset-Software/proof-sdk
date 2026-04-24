/**
 * Tests for U4 — mentions data model and typeahead.
 *
 * - Pure helpers in mention-typeahead.ts (findActiveMentionQuery,
 *   applyMentionSelection).
 * - Server persistence: /marks/comment and /marks/reply accept and persist
 *   the mentions array; malformed mention entries are dropped without
 *   rejecting the whole request.
 * - Typeahead endpoint GET /:slug/viewers returns self + other viewers
 *   after multiple distinct X-Proof-Viewer-Id callers have touched the slug.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

async function testFindActiveQuery(): Promise<void> {
  const { findActiveMentionQuery } = await import('../ui/mention-typeahead');

  assert.deepEqual(
    findActiveMentionQuery('hello @sa', 9),
    { start: 6, end: 9, query: 'sa' },
    'detects @query at end of text',
  );
  assert.deepEqual(
    findActiveMentionQuery('@sam', 4),
    { start: 0, end: 4, query: 'sam' },
    'detects @query at start of text',
  );
  assert.equal(findActiveMentionQuery('', 0), null, 'empty text returns null');
  assert.equal(findActiveMentionQuery('hello world', 5), null, 'no @ in text returns null');
  assert.deepEqual(
    findActiveMentionQuery('hello @sam there', 9),
    { start: 6, end: 9, query: 'sa' },
    'caret mid-query — detects active @query span',
  );
  assert.equal(
    findActiveMentionQuery('email foo@bar', 13),
    null,
    'email @ (preceded by word char) is not a mention',
  );
  assert.equal(
    findActiveMentionQuery('@name with space', 16),
    null,
    'space in query breaks the match',
  );
  assert.equal(
    findActiveMentionQuery(`@${'x'.repeat(60)}`, 61),
    null,
    'query longer than max length returns null',
  );
}

async function testApplyMentionSelection(): Promise<void> {
  const { applyMentionSelection } = await import('../ui/mention-typeahead');

  const before = 'Hello @sa';
  const result = applyMentionSelection(before, 6, 9, {
    kind: 'human',
    viewerId: 'v-1',
    displayName: 'Sam',
  });
  assert.equal(result.text, 'Hello @Sam ', 'inserts @DisplayName and trailing space');
  assert.equal(result.caret, 11, 'caret positioned after the trailing space');
  assert.deepEqual(result.mention, {
    viewerId: 'v-1',
    displayName: 'Sam',
    startOffset: 6,
    endOffset: 10,
  });

  // Pre-existing trailing space — no extra space added.
  const result2 = applyMentionSelection('Hi @sa there', 3, 6, {
    kind: 'human',
    viewerId: 'v-2',
    displayName: 'Sarah',
  });
  assert.equal(result2.text, 'Hi @Sarah there');
  assert.equal(result2.caret, 9);
  assert.deepEqual(result2.mention, {
    viewerId: 'v-2',
    displayName: 'Sarah',
    startOffset: 3,
    endOffset: 9,
  });
}

async function testServerPersistence(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `proof-u4-${randomUUID()}.db`);

  const [{ createDocument, createDocumentAccessToken, getDocumentBySlug }, { agentRoutes }] = await Promise.all([
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
    const slug = 'mention-test';
    createDocument(slug, '# test', {}, 'Mention test', 'owner-1', 'owner-secret-1');
    const access = createDocumentAccessToken(slug, 'editor');

    // Comment with a valid mention.
    const commentRes = await fetch(`${base}/api/agent/${slug}/marks/comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
        'X-Proof-Viewer-Id': 'viewer-author',
        'X-Proof-Viewer-Name': 'Author',
      },
      body: JSON.stringify({
        by: 'human:Author',
        quote: 'test',
        text: 'hey @Sam please review',
        mentions: [
          { viewerId: 'viewer-sam', displayName: 'Sam', startOffset: 4, endOffset: 8 },
          // Malformed — dropped:
          { viewerId: 'bad id with spaces', displayName: 'Bad', startOffset: 0, endOffset: 3 },
          { viewerId: 'viewer-no-name', displayName: '', startOffset: 10, endOffset: 15 },
          { viewerId: 'viewer-bad-offsets', displayName: 'BadOffsets', startOffset: 10, endOffset: 5 },
        ],
      }),
    });
    assert.equal(commentRes.status, 200, 'comment posted');
    const commentBody = await commentRes.json() as { marks?: Record<string, any> };
    const markEntries = Object.entries(commentBody.marks ?? {});
    assert.equal(markEntries.length, 1, 'one mark returned');
    const [markId, mark] = markEntries[0];
    assert.ok(Array.isArray(mark.mentions), 'persisted mentions array');
    assert.equal(mark.mentions.length, 1, 'only the valid mention survives normalization');
    assert.equal(mark.mentions[0].viewerId, 'viewer-sam');
    assert.equal(mark.mentions[0].displayName, 'Sam');

    // Reply with mentions.
    const replyRes = await fetch(`${base}/api/agent/${slug}/marks/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
      },
      body: JSON.stringify({
        markId,
        by: 'human:Replier',
        text: 'sounds good @Trey',
        mentions: [{ viewerId: 'viewer-trey', displayName: 'Trey', startOffset: 12, endOffset: 17 }],
      }),
    });
    assert.equal(replyRes.status, 200, 'reply posted');
    const replyBody = await replyRes.json() as { marks?: Record<string, any> };
    const repliedMark = replyBody.marks?.[markId];
    assert.ok(repliedMark, 'reply returned the mark');
    const replies = repliedMark.replies as Array<any>;
    assert.equal(replies.length, 1, 'one reply persisted');
    assert.deepEqual(replies[0].mentions, [
      { viewerId: 'viewer-trey', displayName: 'Trey', startOffset: 12, endOffset: 17 },
    ]);

    // Absent mentions — mark has no mentions field.
    const plainRes = await fetch(`${base}/api/agent/${slug}/marks/comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': access.secret,
      },
      body: JSON.stringify({ by: 'human:x', quote: 'test', text: 'plain comment no mentions' }),
    });
    assert.equal(plainRes.status, 200);
    const plainBody = await plainRes.json() as { marks?: Record<string, any> };
    const plainMark = Object.values(plainBody.marks ?? {}).find((m: any) => m.text === 'plain comment no mentions') as any;
    assert.ok(plainMark);
    assert.equal(plainMark.mentions, undefined, 'no mentions field when none provided');

    // Typeahead endpoint returns the viewers who have touched this slug.
    // Call as three distinct viewers to populate document_viewers.
    for (const v of ['viewer-a', 'viewer-b', 'viewer-c']) {
      await fetch(`${base}/api/agent/${slug}/state`, {
        headers: {
          'x-share-token': access.secret,
          'X-Proof-Viewer-Id': v,
          'X-Proof-Viewer-Name': v.toUpperCase(),
        },
      });
    }
    const typeaheadRes = await fetch(`${base}/api/agent/${slug}/viewers`, {
      headers: {
        'x-share-token': access.secret,
        'X-Proof-Viewer-Id': 'viewer-a',
      },
    });
    assert.equal(typeaheadRes.status, 200);
    const typeaheadBody = await typeaheadRes.json() as { viewers: Array<{ viewerId: string; displayName: string }> };
    const ids = typeaheadBody.viewers.map((v) => v.viewerId).sort();
    assert.ok(ids.includes('viewer-a'));
    assert.ok(ids.includes('viewer-b'));
    assert.ok(ids.includes('viewer-c'));
    assert.ok(getDocumentBySlug(slug), 'doc still exists');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function run(): Promise<void> {
  await testFindActiveQuery();
  await testApplyMentionSelection();
  await testServerPersistence();
  console.log('mentions.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
