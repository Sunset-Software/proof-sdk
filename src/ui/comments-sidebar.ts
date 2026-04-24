/**
 * Right-rail comments sidebar.
 *
 * Lists comment threads from the live marks plugin state with click-to-jump:
 * clicking a row scrolls the editor to the anchor, pulse-highlights the
 * mark range, and opens the existing inline popover focused on the reply
 * composer.
 *
 * Reads mark state via `getMarks(view.state)` and re-renders on every
 * dispatched transaction. This reuses the same source of truth as the
 * popover, so the two surfaces cannot disagree about the thread list.
 */

import type { EditorView } from 'prosemirror-view';
import type { Mark } from '../formats/marks';
import { getMarks } from '../editor/plugins/marks';
import { openPopoverForMark } from '../editor/plugins/mark-popover';

// ---- Types ------------------------------------------------------

export interface CommentsSidebarOptions {
  /** The ProseMirror view the sidebar observes. */
  view: EditorView;
  /** Where to mount. Defaults to `document.body`. */
  container?: HTMLElement;
  /** Pre-computed "now" for deterministic tests. */
  now?: () => Date;
}

interface ThreadRow {
  markId: string;
  quote: string;
  lastActivityAt: string;
  lastAuthor: string;
  replyCount: number;
  resolved: boolean;
  orphaned: boolean;
  rangeFrom: number | null;
}

// ---- Row derivation --------------------------------------------

/**
 * Derive the sidebar row list from the current marks. Exported for tests —
 * no DOM dependency; given an array of marks, returns the rows in display
 * order with orphaned threads last.
 */
export function deriveCommentRows(marks: Mark[]): { active: ThreadRow[]; detached: ThreadRow[] } {
  const active: ThreadRow[] = [];
  const detached: ThreadRow[] = [];

  for (const mark of marks) {
    if (mark.kind !== 'comment') continue;
    const row = buildRow(mark);
    if (row.orphaned) {
      detached.push(row);
    } else {
      active.push(row);
    }
  }

  // Active rows in document order (lowest range.from first).
  active.sort((a, b) => {
    const af = a.rangeFrom ?? Number.MAX_SAFE_INTEGER;
    const bf = b.rangeFrom ?? Number.MAX_SAFE_INTEGER;
    return af - bf;
  });
  // Detached rows by most recent activity so the newest orphan is at the top.
  detached.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  return { active, detached };
}

function buildRow(mark: Mark): ThreadRow {
  const data = (mark.data ?? {}) as {
    text?: string;
    resolved?: boolean;
    replies?: Array<{ by?: string; text?: string; at?: string }>;
  };
  const replies = Array.isArray(data.replies) ? data.replies : [];
  const latestReply = replies.length > 0 ? replies[replies.length - 1] : null;
  const lastActivityAt = latestReply?.at?.trim() || mark.at || '';
  const lastAuthor = latestReply?.by?.trim() || mark.by || 'ai:unknown';
  return {
    markId: mark.id,
    quote: truncateQuote(mark.quote || ''),
    lastActivityAt,
    lastAuthor,
    replyCount: replies.length,
    resolved: data.resolved === true,
    orphaned: mark.orphaned === true || !mark.range,
    rangeFrom: mark.range?.from ?? null,
  };
}

const QUOTE_LIMIT = 120;

function truncateQuote(quote: string): string {
  const normalized = quote.replace(/\s+/g, ' ').trim();
  if (normalized.length <= QUOTE_LIMIT) return normalized;
  return `${normalized.slice(0, QUOTE_LIMIT - 1).trim()}…`;
}

// ---- Helpers for display ----------------------------------------

export function formatRelativeTime(isoTimestamp: string, now: Date): string {
  if (!isoTimestamp) return '';
  const at = Date.parse(isoTimestamp);
  if (!Number.isFinite(at)) return '';
  const deltaSec = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (deltaSec < 60) return 'just now';
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  if (deltaDay < 30) return `${deltaDay}d ago`;
  return new Date(at).toLocaleDateString();
}

export function formatAuthor(by: string): { label: string; isAgent: boolean } {
  const trimmed = (by || '').trim();
  if (trimmed.startsWith('ai:')) {
    const agentName = trimmed.slice(3) || 'agent';
    return { label: agentName, isAgent: true };
  }
  if (trimmed.startsWith('human:')) {
    const humanName = trimmed.slice(6) || 'Anonymous';
    return { label: humanName, isAgent: false };
  }
  return { label: trimmed || 'Anonymous', isAgent: false };
}

// ---- DOM rendering ---------------------------------------------

const COLLAPSED_STORAGE_KEY = 'proof-comments-sidebar-collapsed';
const SHOW_RESOLVED_STORAGE_KEY = 'proof-comments-sidebar-show-resolved';

function readLocalFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeLocalFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Ignore storage failures; state degrades to per-session only.
  }
}

export interface CommentsSidebarHandle {
  /** Detach the sidebar from the DOM and stop observing the view. */
  destroy: () => void;
  /** Force a re-render — useful from tests. */
  rerender: () => void;
  /** Open the sidebar programmatically (uncollapse). */
  open: () => void;
  /** Collapse the sidebar programmatically. */
  collapse: () => void;
  /** Read the current row list — used by tests. */
  readRows: () => { active: ThreadRow[]; detached: ThreadRow[] };
}

export function initCommentsSidebar(options: CommentsSidebarOptions): CommentsSidebarHandle {
  const view = options.view;
  const container = options.container ?? document.body;
  const now = options.now ?? (() => new Date());

  let collapsed = readLocalFlag(COLLAPSED_STORAGE_KEY);
  let showResolved = readLocalFlag(SHOW_RESOLVED_STORAGE_KEY);

  const root = document.createElement('aside');
  root.className = 'comments-sidebar';
  root.dataset.proofSidebar = 'comments';
  root.setAttribute('aria-label', 'Comments');

  const toggleStrip = document.createElement('button');
  toggleStrip.type = 'button';
  toggleStrip.className = 'comments-sidebar-toggle';
  toggleStrip.setAttribute('aria-label', 'Toggle comments');
  toggleStrip.textContent = '\u{1F4AC}';
  toggleStrip.addEventListener('click', () => {
    collapsed = !collapsed;
    writeLocalFlag(COLLAPSED_STORAGE_KEY, collapsed);
    applyCollapsedClass();
  });

  const panel = document.createElement('div');
  panel.className = 'comments-sidebar-panel';

  const header = document.createElement('div');
  header.className = 'comments-sidebar-header';
  const title = document.createElement('div');
  title.className = 'comments-sidebar-title';
  title.textContent = 'Comments';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'comments-sidebar-close';
  closeButton.setAttribute('aria-label', 'Collapse comments sidebar');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => {
    collapsed = true;
    writeLocalFlag(COLLAPSED_STORAGE_KEY, true);
    applyCollapsedClass();
  });
  header.appendChild(title);
  header.appendChild(closeButton);

  const filters = document.createElement('div');
  filters.className = 'comments-sidebar-filters';
  const resolvedToggle = document.createElement('label');
  resolvedToggle.className = 'comments-sidebar-resolved-toggle';
  const resolvedCheckbox = document.createElement('input');
  resolvedCheckbox.type = 'checkbox';
  resolvedCheckbox.checked = showResolved;
  resolvedCheckbox.addEventListener('change', () => {
    showResolved = resolvedCheckbox.checked;
    writeLocalFlag(SHOW_RESOLVED_STORAGE_KEY, showResolved);
    render();
  });
  const resolvedLabel = document.createElement('span');
  resolvedLabel.textContent = 'Show resolved';
  resolvedToggle.appendChild(resolvedCheckbox);
  resolvedToggle.appendChild(resolvedLabel);
  filters.appendChild(resolvedToggle);

  const list = document.createElement('div');
  list.className = 'comments-sidebar-list';

  panel.appendChild(header);
  panel.appendChild(filters);
  panel.appendChild(list);

  root.appendChild(toggleStrip);
  root.appendChild(panel);
  container.appendChild(root);

  function applyCollapsedClass(): void {
    root.classList.toggle('comments-sidebar-collapsed', collapsed);
  }

  let lastRows: { active: ThreadRow[]; detached: ThreadRow[] } = { active: [], detached: [] };

  function render(): void {
    const marks = getMarks(view.state);
    const rows = deriveCommentRows(marks);
    lastRows = rows;

    const visibleActive = showResolved
      ? rows.active
      : rows.active.filter((row) => !row.resolved);

    list.textContent = '';

    if (visibleActive.length === 0 && rows.detached.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'comments-sidebar-empty';
      empty.textContent = rows.active.length === 0
        ? 'No comments yet. Select text and add a comment to start a thread.'
        : 'All threads are resolved.';
      list.appendChild(empty);
      return;
    }

    for (const row of visibleActive) {
      list.appendChild(renderRow(row));
    }

    if (rows.detached.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'comments-sidebar-section-heading';
      heading.textContent = 'Detached';
      list.appendChild(heading);
      for (const row of rows.detached) {
        list.appendChild(renderRow(row));
      }
    }
  }

  function renderRow(row: ThreadRow): HTMLElement {
    const rowEl = document.createElement('button');
    rowEl.type = 'button';
    rowEl.className = 'comments-sidebar-row';
    if (row.resolved) rowEl.classList.add('comments-sidebar-row-resolved');
    if (row.orphaned) rowEl.classList.add('comments-sidebar-row-detached');
    rowEl.dataset.markId = row.markId;

    const quote = document.createElement('div');
    quote.className = 'comments-sidebar-quote';
    quote.textContent = row.quote || '(no anchor text)';
    rowEl.appendChild(quote);

    const meta = document.createElement('div');
    meta.className = 'comments-sidebar-meta';
    const author = formatAuthor(row.lastAuthor);
    const authorSpan = document.createElement('span');
    authorSpan.className = author.isAgent
      ? 'comments-sidebar-author comments-sidebar-author-agent'
      : 'comments-sidebar-author';
    authorSpan.textContent = author.label;
    meta.appendChild(authorSpan);

    const time = document.createElement('span');
    time.className = 'comments-sidebar-time';
    time.textContent = formatRelativeTime(row.lastActivityAt, now());
    meta.appendChild(time);

    if (row.replyCount > 0) {
      const chip = document.createElement('span');
      chip.className = 'comments-sidebar-chip comments-sidebar-chip-replies';
      chip.textContent = `${row.replyCount}`;
      meta.appendChild(chip);
    }
    if (row.resolved) {
      const chip = document.createElement('span');
      chip.className = 'comments-sidebar-chip comments-sidebar-chip-resolved';
      chip.textContent = 'Resolved';
      meta.appendChild(chip);
    }

    rowEl.appendChild(meta);

    rowEl.addEventListener('click', () => {
      scrollToMark(view, row.markId);
      openPopoverForMark(view, row.markId);
    });

    return rowEl;
  }

  applyCollapsedClass();
  render();

  // Observe ProseMirror state changes by wrapping dispatchTransaction.
  // This is safe — it calls through to the existing dispatcher.
  const originalDispatch = view.props.dispatchTransaction?.bind(view);
  const dispatchHandler = (tr: Parameters<NonNullable<typeof view.props.dispatchTransaction>>[0]): void => {
    if (originalDispatch) {
      originalDispatch(tr);
    } else {
      view.updateState(view.state.apply(tr));
    }
    // Only re-render when something visible changed (docChanged or mark plugin state).
    // Cheaper than re-reading getMarks on every selection-only transaction.
    if (tr.docChanged || tr.getMeta('marks') != null) {
      render();
    }
  };
  view.setProps({ dispatchTransaction: dispatchHandler });

  return {
    destroy: () => {
      view.setProps({ dispatchTransaction: originalDispatch });
      root.remove();
    },
    rerender: render,
    open: () => {
      collapsed = false;
      writeLocalFlag(COLLAPSED_STORAGE_KEY, false);
      applyCollapsedClass();
    },
    collapse: () => {
      collapsed = true;
      writeLocalFlag(COLLAPSED_STORAGE_KEY, true);
      applyCollapsedClass();
    },
    readRows: () => lastRows,
  };
}

// ---- Scroll + pulse ---------------------------------------------

function scrollToMark(view: EditorView, markId: string): void {
  const mark = getMarks(view.state).find((entry) => entry.id === markId);
  if (!mark || !mark.range) return;
  const { from } = mark.range;
  const docSize = view.state.doc.content.size;
  const clampedFrom = Math.max(0, Math.min(from, Math.max(0, docSize - 1)));
  try {
    const coords = view.coordsAtPos(clampedFrom);
    const scrollY = window.scrollY + coords.top - Math.max(120, window.innerHeight / 4);
    window.scrollTo({ top: Math.max(0, scrollY), behavior: 'smooth' });
  } catch {
    // Position may be out of range during a mid-transition; fall back to focus.
    view.focus();
  }
  pulseMark(view, markId);
}

function pulseMark(view: EditorView, markId: string): void {
  const dom = view.dom as HTMLElement;
  if (!dom) return;
  const node = dom.querySelector<HTMLElement>(`[data-mark-id="${markId}"]`);
  if (!node) return;
  node.classList.add('comments-sidebar-pulse');
  window.setTimeout(() => {
    node.classList.remove('comments-sidebar-pulse');
  }, 1200);
}
