/**
 * @-mention typeahead attachment for textareas.
 *
 * Watches a textarea for an active `@query` span ending at the caret.
 * When one is found, queries the provided data source and renders a small
 * popup list below the textarea. Keyboard navigation: ArrowUp/Down move
 * the highlight, Enter/Tab selects, Escape dismisses.
 *
 * Selection replaces the `@query` span with `@DisplayName ` (trailing
 * space) and records a MentionRef in an internal array exposed via
 * getMentions(). Callers pass the array back to the server on submit.
 *
 * Intentionally DOM-heavy and untestable without jsdom — the pure logic
 * (active query detection, display-name insertion offsets) is extracted
 * into exported helpers for unit coverage.
 */

export interface MentionCandidate {
  kind: 'human' | 'agent';
  viewerId: string;
  displayName: string;
  lastSeenAt?: string;
}

export interface MentionRef {
  viewerId: string;
  displayName: string;
  startOffset: number;
  endOffset: number;
}

export interface MentionTypeaheadOptions {
  textarea: HTMLTextAreaElement;
  /** Fetch candidates for the given query. */
  fetchCandidates: (query: string) => Promise<MentionCandidate[]>;
}

export interface MentionTypeaheadHandle {
  /** Get the mentions recorded so far. */
  getMentions: () => MentionRef[];
  /** Clear the mentions array — called after a successful submit. */
  resetMentions: () => void;
  /** Detach listeners and remove the popup. */
  destroy: () => void;
}

// ---- Pure helpers (tested separately) ---------------------------

/**
 * Find the active `@query` span ending at the caret, if any.
 * Returns null when no `@` precedes the caret without an intervening
 * whitespace or the query is longer than MAX_QUERY_LENGTH.
 */
export function findActiveMentionQuery(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const MAX_QUERY_LENGTH = 48;
  if (caret <= 0 || caret > text.length) return null;
  // Scan backwards from caret for an unescaped @ not preceded by a word char.
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
      // @ must be at the start or follow whitespace/punctuation (not a word char).
      const prev = i > 0 ? text[i - 1] : '';
      if (prev && /[\w@]/.test(prev)) return null;
      const start = i;
      const end = caret;
      const query = text.slice(start + 1, end);
      if (query.length > MAX_QUERY_LENGTH) return null;
      if (/[\s@]/.test(query)) return null;
      return { start, end, query };
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/**
 * Build the {text, caret, mention} result for selecting a candidate
 * against the current text + active query span.
 */
export function applyMentionSelection(
  text: string,
  activeStart: number,
  activeEnd: number,
  candidate: MentionCandidate,
): { text: string; caret: number; mention: MentionRef } {
  const token = `@${candidate.displayName}`;
  const before = text.slice(0, activeStart);
  const after = text.slice(activeEnd);
  // Trailing space for typing flow. Skip when the next character is already
  // whitespace to avoid producing a double space.
  const spacer = after.length > 0 && /\s/.test(after[0]) ? '' : ' ';
  const nextText = `${before}${token}${spacer}${after}`;
  const mention: MentionRef = {
    viewerId: candidate.viewerId,
    displayName: candidate.displayName,
    startOffset: activeStart,
    endOffset: activeStart + token.length,
  };
  const caret = activeStart + token.length + spacer.length;
  return { text: nextText, caret, mention };
}

// ---- DOM attachment --------------------------------------------

export function attachMentionTypeahead(options: MentionTypeaheadOptions): MentionTypeaheadHandle {
  const { textarea, fetchCandidates } = options;

  let mentions: MentionRef[] = [];
  let popup: HTMLDivElement | null = null;
  let candidates: MentionCandidate[] = [];
  let highlightedIndex = 0;
  let activeSpan: { start: number; end: number } | null = null;
  let fetchToken = 0;

  function ensurePopup(): HTMLDivElement {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.className = 'mention-typeahead-popup';
    popup.setAttribute('role', 'listbox');
    popup.style.position = 'absolute';
    popup.style.display = 'none';
    textarea.parentElement?.appendChild(popup);
    // Parent must be positioned so absolute anchoring works.
    const parent = textarea.parentElement;
    if (parent) {
      const computed = window.getComputedStyle(parent);
      if (computed.position === 'static') {
        parent.style.position = 'relative';
      }
    }
    return popup;
  }

  function hidePopup(): void {
    if (popup) popup.style.display = 'none';
    activeSpan = null;
    candidates = [];
    highlightedIndex = 0;
  }

  function renderPopup(): void {
    const el = ensurePopup();
    el.textContent = '';
    if (candidates.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    // Position under the textarea.
    el.style.left = `${textarea.offsetLeft}px`;
    el.style.top = `${textarea.offsetTop + textarea.offsetHeight}px`;
    el.style.width = `${textarea.offsetWidth}px`;
    candidates.forEach((cand, idx) => {
      const row = document.createElement('div');
      row.className = 'mention-typeahead-row';
      if (idx === highlightedIndex) row.classList.add('mention-typeahead-row-active');
      row.setAttribute('role', 'option');
      row.dataset.index = String(idx);
      const primary = document.createElement('div');
      primary.className = 'mention-typeahead-name';
      primary.textContent = cand.displayName;
      const secondary = document.createElement('div');
      secondary.className = 'mention-typeahead-meta';
      secondary.textContent = cand.kind === 'agent' ? 'Agent' : 'Viewer';
      row.appendChild(primary);
      row.appendChild(secondary);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        select(idx);
      });
      row.addEventListener('mousemove', () => {
        if (highlightedIndex !== idx) {
          highlightedIndex = idx;
          renderPopup();
        }
      });
      el.appendChild(row);
    });
  }

  async function updateQuery(): Promise<void> {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const active = findActiveMentionQuery(textarea.value, caret);
    if (!active) {
      hidePopup();
      return;
    }
    activeSpan = { start: active.start, end: active.end };
    const myToken = ++fetchToken;
    const results = await fetchCandidates(active.query);
    if (myToken !== fetchToken) return;
    candidates = results.slice(0, 10);
    highlightedIndex = 0;
    renderPopup();
  }

  function select(index: number): void {
    if (!activeSpan) return;
    const cand = candidates[index];
    if (!cand) return;
    const { text: nextText, caret, mention } = applyMentionSelection(
      textarea.value,
      activeSpan.start,
      activeSpan.end,
      cand,
    );
    textarea.value = nextText;
    textarea.setSelectionRange(caret, caret);
    mentions.push(mention);
    // Dispatch an input event so listeners (draft tracker, submit enable) react.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    hidePopup();
  }

  function onInput(): void {
    void updateQuery();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!activeSpan || candidates.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightedIndex = (highlightedIndex + 1) % candidates.length;
      renderPopup();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightedIndex = (highlightedIndex - 1 + candidates.length) % candidates.length;
      renderPopup();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      select(highlightedIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hidePopup();
    }
  }

  function onBlur(): void {
    // Small delay so click handlers on popup rows can fire first.
    window.setTimeout(() => hidePopup(), 120);
  }

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeyDown, true);
  textarea.addEventListener('blur', onBlur);

  return {
    getMentions: () => [...mentions],
    resetMentions: () => { mentions = []; },
    destroy: () => {
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('keydown', onKeyDown, true);
      textarea.removeEventListener('blur', onBlur);
      if (popup) popup.remove();
      popup = null;
      mentions = [];
    },
  };
}
