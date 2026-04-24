/**
 * Unit tests for the comments sidebar row-derivation and formatting helpers (U2).
 *
 * DOM rendering, ProseMirror wiring, and popover integration are exercised in
 * browser/e2e paths; these tests cover the pure logic layer that the rest of
 * the component builds on.
 */

import assert from 'node:assert/strict';
import type { Mark } from '../formats/marks';

// Stub a minimal window for the module's localStorage helpers without
// triggering DOM construction.
(globalThis as any).window = {
  localStorage: {
    _data: new Map<string, string>(),
    getItem(key: string): string | null { return this._data.has(key) ? this._data.get(key)! : null; },
    setItem(key: string, value: string): void { this._data.set(key, value); },
    removeItem(key: string): void { this._data.delete(key); },
  },
};

async function testDeriveRows(): Promise<void> {
  const { deriveCommentRows } = await import('../ui/comments-sidebar');

  const marks: Mark[] = [
    {
      id: 'm1',
      kind: 'comment',
      by: 'human:Sam',
      at: '2026-04-23T10:00:00.000Z',
      quote: 'First',
      range: { from: 120, to: 125 },
      data: { text: 'hi', thread: 'm1', resolved: false, replies: [] } as Mark['data'],
    },
    {
      id: 'm2',
      kind: 'comment',
      by: 'ai:claude',
      at: '2026-04-23T09:00:00.000Z',
      quote: 'Second',
      range: { from: 40, to: 60 },
      data: {
        text: 'anchor',
        thread: 'm2',
        resolved: false,
        replies: [
          { by: 'human:Trey', text: 'yep', at: '2026-04-23T11:00:00.000Z' },
          { by: 'ai:claude', text: 'ok', at: '2026-04-23T11:05:00.000Z' },
        ],
      } as Mark['data'],
    },
    {
      id: 'm3',
      kind: 'comment',
      by: 'human:Kai',
      at: '2026-04-23T08:00:00.000Z',
      quote: 'Detached original text',
      orphaned: true,
      data: { text: 'still here', thread: 'm3', resolved: false, replies: [] } as Mark['data'],
    },
    {
      id: 'm4',
      kind: 'comment',
      by: 'human:Sam',
      at: '2026-04-23T07:00:00.000Z',
      quote: 'Resolved',
      range: { from: 10, to: 20 },
      data: { text: 'done', thread: 'm4', resolved: true, replies: [] } as Mark['data'],
    },
    {
      // Non-comment marks are ignored.
      id: 'm5',
      kind: 'insert',
      by: 'ai:claude',
      at: '2026-04-23T09:30:00.000Z',
      quote: 'Suggestion',
      range: { from: 70, to: 80 },
      data: { content: '+', status: 'pending' } as Mark['data'],
    },
  ];

  const { active, detached } = deriveCommentRows(marks);

  assert.equal(active.length, 3, 'three active comment rows (resolved included, suggestion excluded)');
  assert.deepEqual(
    active.map((r) => r.markId),
    ['m4', 'm2', 'm1'],
    'active rows sorted by document-order range.from (10 < 40 < 120)',
  );
  assert.equal(detached.length, 1, 'one detached row');
  assert.equal(detached[0].markId, 'm3');

  const m2 = active.find((r) => r.markId === 'm2')!;
  assert.equal(m2.replyCount, 2, 'reply count reflects the replies array');
  assert.equal(
    m2.lastActivityAt,
    '2026-04-23T11:05:00.000Z',
    'lastActivityAt comes from the most recent reply when present',
  );
  assert.equal(m2.lastAuthor, 'ai:claude', 'lastAuthor comes from the most recent reply');

  const m1 = active.find((r) => r.markId === 'm1')!;
  assert.equal(m1.lastActivityAt, '2026-04-23T10:00:00.000Z', 'lastActivityAt falls back to mark.at when no replies');
  assert.equal(m1.lastAuthor, 'human:Sam', 'lastAuthor falls back to mark.by');
  assert.equal(m1.resolved, false);

  const m4 = active.find((r) => r.markId === 'm4')!;
  assert.equal(m4.resolved, true, 'resolved flag carried through');
}

async function testTruncation(): Promise<void> {
  const { deriveCommentRows } = await import('../ui/comments-sidebar');
  const longQuote = 'a'.repeat(300);
  const marks: Mark[] = [
    {
      id: 'long',
      kind: 'comment',
      by: 'human:Long',
      at: '2026-04-23T09:00:00.000Z',
      quote: longQuote,
      range: { from: 0, to: 10 },
      data: { text: 'x', thread: 'long', resolved: false, replies: [] } as Mark['data'],
    },
  ];
  const { active } = deriveCommentRows(marks);
  assert.ok(active[0].quote.length <= 120, `quote must be truncated; got length=${active[0].quote.length}`);
  assert.ok(active[0].quote.endsWith('…'), 'truncated quotes end with an ellipsis');
}

async function testRelativeTime(): Promise<void> {
  const { formatRelativeTime } = await import('../ui/comments-sidebar');
  const now = new Date('2026-04-23T12:00:00.000Z');

  assert.equal(formatRelativeTime('2026-04-23T11:59:30.000Z', now), 'just now');
  assert.equal(formatRelativeTime('2026-04-23T11:45:00.000Z', now), '15m ago');
  assert.equal(formatRelativeTime('2026-04-23T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelativeTime('2026-04-20T12:00:00.000Z', now), '3d ago');
  assert.equal(formatRelativeTime('', now), '');
  assert.equal(formatRelativeTime('not a date', now), '');
}

async function testAuthorFormat(): Promise<void> {
  const { formatAuthor } = await import('../ui/comments-sidebar');

  assert.deepEqual(formatAuthor('human:Sam'), { label: 'Sam', isAgent: false });
  assert.deepEqual(formatAuthor('ai:claude-opus'), { label: 'claude-opus', isAgent: true });
  assert.deepEqual(formatAuthor('unknown-prefix'), { label: 'unknown-prefix', isAgent: false });
  assert.deepEqual(formatAuthor(''), { label: 'Anonymous', isAgent: false });
  assert.deepEqual(formatAuthor('ai:'), { label: 'agent', isAgent: true });
  assert.deepEqual(formatAuthor('human:'), { label: 'Anonymous', isAgent: false });
}

async function run(): Promise<void> {
  await testDeriveRows();
  await testTruncation();
  await testRelativeTime();
  await testAuthorFormat();
  console.log('comments-sidebar.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
