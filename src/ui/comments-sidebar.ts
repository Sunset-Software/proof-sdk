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
import {
  attachMentionTypeahead,
  type MentionCandidate,
  type MentionRef,
  type MentionTypeaheadHandle,
} from './mention-typeahead';

// ---- Types ------------------------------------------------------

export type PostReplyResult =
  | { ok: true }
  | { ok: false; code?: string; message: string };

export interface CommentsSidebarOptions {
  /** The ProseMirror view the sidebar observes. */
  view: EditorView;
  /** Where to mount. Defaults to `document.body`. */
  container?: HTMLElement;
  /** Pre-computed "now" for deterministic tests. */
  now?: () => Date;
  /**
   * Resolve the author label for replies posted from the sidebar composer.
   * Defaults to the lazy 'human:Anonymous'. Implementations typically
   * return `human:${viewerName}`.
   */
  getAuthorLabel?: () => string;
  /**
   * Post a reply to the given thread. Implementations wrap
   * shareClient.postCommentReply or an equivalent. Returning ok=true
   * signals the sidebar to clear the composer and await the next
   * re-render. Non-ok results are surfaced as inline errors.
   */
  postReply?: (markId: string, text: string, mentions?: MentionRef[]) => Promise<PostReplyResult>;
  /**
   * Fetch mention candidates (humans + agents) matching a query.
   * When omitted, @-typeahead is disabled — the composer still works
   * as a plain-text reply.
   */
  fetchMentionCandidates?: (query: string) => Promise<MentionCandidate[]>;
  /**
   * Fetch the viewer's Inbox — threads with activity since last visit.
   * When omitted, the Inbox tab is hidden and only the Doc tab renders.
   */
  fetchInbox?: (filter: { mentioningMe?: boolean; fromAgents?: boolean }) => Promise<{
    threads: InboxThread[];
    unreadCount: number;
  }>;
  /** Mark a single thread read for the current viewer. */
  markThreadSeen?: (threadId: string) => Promise<boolean>;
  /** Mark every thread on this doc read for the current viewer. */
  markAllThreadsSeen?: () => Promise<number>;
}

export interface InboxThread {
  threadId: string;
  markId: string;
  latestActivityAt: string;
  latestText: string;
  latestAuthor: string;
  replyCount: number;
  resolved: boolean;
  mentionsMe: boolean;
  unread: boolean;
  quote: string;
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
  const getAuthorLabel = options.getAuthorLabel ?? (() => 'human:Anonymous');
  const postReplyFn = options.postReply ?? null;
  const fetchMentionCandidatesFn = options.fetchMentionCandidates ?? null;
  const fetchInboxFn = options.fetchInbox ?? null;
  const markThreadSeenFn = options.markThreadSeen ?? null;
  const markAllThreadsSeenFn = options.markAllThreadsSeen ?? null;
  const inboxAvailable = Boolean(fetchInboxFn);
  type ActiveTab = 'doc' | 'inbox';
  type InboxFilter = 'all' | 'mentioningMe' | 'fromAgents';
  let activeTab: ActiveTab = 'doc';
  let inboxFilter: InboxFilter = 'all';
  let inboxCache: { threads: InboxThread[]; unreadCount: number } = { threads: [], unreadCount: 0 };
  let inboxInFlight = false;

  let collapsed = readLocalFlag(COLLAPSED_STORAGE_KEY);
  let showResolved = readLocalFlag(SHOW_RESOLVED_STORAGE_KEY);
  let expandedMarkId: string | null = null;
  // Draft text preserved across re-renders so a re-render from an
  // incoming mark update does not blow away what the user is typing.
  const drafts = new Map<string, string>();
  let activeInFlightMarkId: string | null = null;

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

  // Tabs.
  const tabs = document.createElement('div');
  tabs.className = 'comments-sidebar-tabs';
  const docTabBtn = document.createElement('button');
  docTabBtn.type = 'button';
  docTabBtn.className = 'comments-sidebar-tab comments-sidebar-tab-active';
  docTabBtn.textContent = 'Doc';
  docTabBtn.addEventListener('click', () => {
    if (activeTab === 'doc') return;
    activeTab = 'doc';
    render();
  });
  const inboxTabBtn = document.createElement('button');
  inboxTabBtn.type = 'button';
  inboxTabBtn.className = 'comments-sidebar-tab';
  inboxTabBtn.textContent = 'Inbox';
  const inboxBadge = document.createElement('span');
  inboxBadge.className = 'comments-sidebar-tab-badge';
  inboxBadge.hidden = true;
  inboxTabBtn.appendChild(inboxBadge);
  inboxTabBtn.addEventListener('click', () => {
    if (!inboxAvailable) return;
    if (activeTab === 'inbox') return;
    activeTab = 'inbox';
    void refreshInbox();
    render();
  });
  tabs.appendChild(docTabBtn);
  if (inboxAvailable) tabs.appendChild(inboxTabBtn);

  // Filters row — contents change per tab.
  const filters = document.createElement('div');
  filters.className = 'comments-sidebar-filters';

  const list = document.createElement('div');
  list.className = 'comments-sidebar-list';

  panel.appendChild(header);
  panel.appendChild(tabs);
  panel.appendChild(filters);
  panel.appendChild(list);

  root.appendChild(toggleStrip);
  root.appendChild(panel);
  container.appendChild(root);

  function applyCollapsedClass(): void {
    root.classList.toggle('comments-sidebar-collapsed', collapsed);
  }

  let lastRows: { active: ThreadRow[]; detached: ThreadRow[] } = { active: [], detached: [] };

  async function refreshInbox(): Promise<void> {
    if (!fetchInboxFn || inboxInFlight) return;
    inboxInFlight = true;
    try {
      const result = await fetchInboxFn({
        mentioningMe: inboxFilter === 'mentioningMe',
        fromAgents: inboxFilter === 'fromAgents',
      });
      inboxCache = result;
      if (activeTab === 'inbox') render();
      else {
        // Still update the badge even when the Inbox isn't visible.
        updateInboxBadge();
      }
    } finally {
      inboxInFlight = false;
    }
  }

  function updateInboxBadge(): void {
    if (!inboxAvailable) return;
    if (inboxCache.unreadCount > 0) {
      inboxBadge.hidden = false;
      inboxBadge.textContent = inboxCache.unreadCount > 99 ? '99+' : String(inboxCache.unreadCount);
    } else {
      inboxBadge.hidden = true;
      inboxBadge.textContent = '';
    }
  }

  function renderFilters(): void {
    filters.textContent = '';
    if (activeTab === 'doc') {
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
    } else {
      const chipRow = document.createElement('div');
      chipRow.className = 'comments-sidebar-filter-chips';
      (['all', 'mentioningMe', 'fromAgents'] as InboxFilter[]).forEach((key) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'comments-sidebar-filter-chip';
        if (inboxFilter === key) chip.classList.add('comments-sidebar-filter-chip-active');
        chip.textContent = key === 'all' ? 'All' : key === 'mentioningMe' ? 'Mentioning me' : 'From agents';
        chip.addEventListener('click', () => {
          if (inboxFilter === key) return;
          inboxFilter = key;
          void refreshInbox();
          render();
        });
        chipRow.appendChild(chip);
      });
      filters.appendChild(chipRow);

      if (markAllThreadsSeenFn && inboxCache.unreadCount > 0) {
        const markAll = document.createElement('button');
        markAll.type = 'button';
        markAll.className = 'comments-sidebar-mark-all';
        markAll.textContent = 'Mark all read';
        markAll.addEventListener('click', async () => {
          await markAllThreadsSeenFn();
          await refreshInbox();
        });
        filters.appendChild(markAll);
      }
    }
  }

  function render(): void {
    // Update tab state.
    docTabBtn.classList.toggle('comments-sidebar-tab-active', activeTab === 'doc');
    inboxTabBtn.classList.toggle('comments-sidebar-tab-active', activeTab === 'inbox');
    updateInboxBadge();
    renderFilters();

    list.textContent = '';
    if (activeTab === 'doc') {
      renderDocList();
    } else {
      renderInboxList();
    }
  }

  function renderDocList(): void {
    const marks = getMarks(view.state);
    const rows = deriveCommentRows(marks);
    lastRows = rows;

    const visibleActive = showResolved
      ? rows.active
      : rows.active.filter((row) => !row.resolved);

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

  function renderInboxList(): void {
    if (inboxCache.threads.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'comments-sidebar-empty';
      empty.textContent = inboxInFlight ? 'Loading…' : 'You’re all caught up.';
      list.appendChild(empty);
      return;
    }
    for (const thread of inboxCache.threads) {
      list.appendChild(renderInboxRow(thread));
    }
  }

  function renderInboxRow(thread: InboxThread): HTMLElement {
    const rowEl = document.createElement('button');
    rowEl.type = 'button';
    rowEl.className = 'comments-sidebar-row comments-sidebar-row-inbox';
    if (thread.unread) rowEl.classList.add('comments-sidebar-row-unread');
    if (thread.resolved) rowEl.classList.add('comments-sidebar-row-resolved');
    rowEl.dataset.threadId = thread.threadId;

    const snippet = document.createElement('div');
    snippet.className = 'comments-sidebar-quote';
    snippet.textContent = (thread.latestText || thread.quote || '(no text)').slice(0, 240);
    rowEl.appendChild(snippet);

    const meta = document.createElement('div');
    meta.className = 'comments-sidebar-meta';
    if (thread.unread) {
      const dot = document.createElement('span');
      dot.className = 'comments-sidebar-unread-dot';
      meta.appendChild(dot);
    }
    const author = formatAuthor(thread.latestAuthor);
    const authorSpan = document.createElement('span');
    authorSpan.className = author.isAgent
      ? 'comments-sidebar-author comments-sidebar-author-agent'
      : 'comments-sidebar-author';
    authorSpan.textContent = author.label;
    meta.appendChild(authorSpan);
    const time = document.createElement('span');
    time.className = 'comments-sidebar-time';
    time.textContent = formatRelativeTime(thread.latestActivityAt, now());
    meta.appendChild(time);
    if (thread.mentionsMe) {
      const chip = document.createElement('span');
      chip.className = 'comments-sidebar-chip comments-sidebar-chip-mentions';
      chip.textContent = '@ you';
      meta.appendChild(chip);
    }
    if (thread.replyCount > 0) {
      const chip = document.createElement('span');
      chip.className = 'comments-sidebar-chip comments-sidebar-chip-replies';
      chip.textContent = `${thread.replyCount}`;
      meta.appendChild(chip);
    }
    rowEl.appendChild(meta);

    rowEl.addEventListener('click', () => {
      if (markThreadSeenFn) {
        void markThreadSeenFn(thread.threadId).then(() => {
          // Update local cache so the badge shrinks without waiting for a round-trip.
          const prev = inboxCache.threads.find((t) => t.threadId === thread.threadId);
          if (prev?.unread) {
            prev.unread = false;
            inboxCache.unreadCount = Math.max(0, inboxCache.unreadCount - 1);
            updateInboxBadge();
          }
        });
      }
      scrollToMark(view, thread.markId);
      openPopoverForMark(view, thread.markId);
    });

    return rowEl;
  }

  function renderRow(row: ThreadRow): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.className = 'comments-sidebar-row';
    if (row.resolved) rowEl.classList.add('comments-sidebar-row-resolved');
    if (row.orphaned) rowEl.classList.add('comments-sidebar-row-detached');
    rowEl.dataset.markId = row.markId;

    const isExpanded = expandedMarkId === row.markId;
    if (isExpanded) rowEl.classList.add('comments-sidebar-row-expanded');

    // Clickable header — scroll + popover.
    const headerButton = document.createElement('button');
    headerButton.type = 'button';
    headerButton.className = 'comments-sidebar-row-header';
    headerButton.setAttribute('aria-label', 'Open thread in editor');
    headerButton.addEventListener('click', () => {
      scrollToMark(view, row.markId);
      openPopoverForMark(view, row.markId);
    });

    const quote = document.createElement('div');
    quote.className = 'comments-sidebar-quote';
    quote.textContent = row.quote || '(no anchor text)';
    headerButton.appendChild(quote);

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

    headerButton.appendChild(meta);
    rowEl.appendChild(headerButton);

    // Reply affordance and expandable composer. Only shown when a postReply
    // implementation is provided (local-only sidebars omit the composer
    // entirely to avoid an affordance with no backend).
    if (postReplyFn && !row.orphaned) {
      const actions = document.createElement('div');
      actions.className = 'comments-sidebar-row-actions';
      const replyButton = document.createElement('button');
      replyButton.type = 'button';
      replyButton.className = 'comments-sidebar-row-reply-toggle';
      replyButton.textContent = isExpanded ? 'Cancel' : 'Reply';
      replyButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (expandedMarkId === row.markId) {
          expandedMarkId = null;
        } else {
          expandedMarkId = row.markId;
        }
        render();
      });
      actions.appendChild(replyButton);
      rowEl.appendChild(actions);

      if (isExpanded) {
        rowEl.appendChild(renderComposer(row.markId));
      }
    }

    return rowEl;
  }

  function renderComposer(markId: string): HTMLElement {
    const composer = document.createElement('div');
    composer.className = 'comments-sidebar-composer';

    const textarea = document.createElement('textarea');
    textarea.className = 'comments-sidebar-composer-textarea';
    textarea.placeholder = fetchMentionCandidatesFn ? 'Write a reply… use @ to mention' : 'Write a reply…';
    textarea.rows = 3;
    textarea.value = drafts.get(markId) ?? '';
    textarea.dataset.composerMarkId = markId;
    textarea.addEventListener('input', () => {
      drafts.set(markId, textarea.value);
      updateSubmitState();
    });

    let typeahead: MentionTypeaheadHandle | null = null;
    if (fetchMentionCandidatesFn) {
      typeahead = attachMentionTypeahead({
        textarea,
        fetchCandidates: fetchMentionCandidatesFn,
      });
    }

    const errorEl = document.createElement('div');
    errorEl.className = 'comments-sidebar-composer-error';
    errorEl.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'comments-sidebar-composer-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'comments-sidebar-composer-cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', (event) => {
      event.stopPropagation();
      drafts.delete(markId);
      expandedMarkId = null;
      render();
    });

    const postButton = document.createElement('button');
    postButton.type = 'button';
    postButton.className = 'comments-sidebar-composer-post';
    postButton.textContent = 'Post';

    function updateSubmitState(): void {
      const hasText = textarea.value.trim().length > 0;
      const disabled = !hasText || activeInFlightMarkId === markId;
      postButton.disabled = disabled;
      postButton.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }

    async function submit(): Promise<void> {
      if (!postReplyFn) return;
      const text = textarea.value.trim();
      if (!text) return;
      if (activeInFlightMarkId) return;
      activeInFlightMarkId = markId;
      postButton.textContent = 'Posting…';
      updateSubmitState();
      errorEl.hidden = true;
      // Only retain mentions whose token still appears in the (final) text.
      // A user typing @Sam and then deleting the token should not leave a
      // stale MentionRef in the payload.
      const collectedMentions = typeahead ? typeahead.getMentions() : [];
      const finalMentions = collectedMentions.filter((m) => {
        const slice = text.slice(m.startOffset, m.endOffset);
        return slice === `@${m.displayName}`;
      });
      try {
        const result = await postReplyFn(markId, text, finalMentions);
        if (result.ok) {
          drafts.delete(markId);
          typeahead?.resetMentions();
          expandedMarkId = null;
          render();
        } else {
          errorEl.hidden = false;
          errorEl.textContent = result.message;
          postButton.textContent = 'Post';
        }
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = err instanceof Error ? err.message : 'Reply failed';
        postButton.textContent = 'Post';
      } finally {
        activeInFlightMarkId = null;
        updateSubmitState();
      }
    }

    postButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void submit();
    });
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        drafts.delete(markId);
        expandedMarkId = null;
        render();
      }
    });

    actions.appendChild(cancelButton);
    actions.appendChild(postButton);

    composer.appendChild(textarea);
    composer.appendChild(errorEl);
    composer.appendChild(actions);

    updateSubmitState();

    // Focus the textarea on expansion without blocking the render.
    window.setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);

    // Provide the author label to screen readers implicitly via aria-label
    // on the textarea — keep the UI clean of a visible "Replying as" hint
    // since the composer is contextual to a specific thread.
    textarea.setAttribute('aria-label', `Reply as ${getAuthorLabel()}`);

    return composer;
  }

  applyCollapsedClass();
  render();
  if (inboxAvailable) void refreshInbox();

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
