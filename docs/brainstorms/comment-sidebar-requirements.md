# Comment Sidebar with Inbox and @-Mentions

**Date:** 2026-04-23
**Status:** Requirements captured; ready for planning
**Scope:** Standard, feature-tier

## Problem

Comments on a Proof doc are only discoverable by clicking a marked span. There is no aggregated view, no "what's new since I was last here" signal, and no way to direct a comment at a specific collaborator. Agents leave comments on docs but humans have no return surface to see them.

## Users and primary flows

- **Human reviewers** returning to a doc to catch up on agent or peer activity.
- **Human collaborators** working async with other humans who need to direct attention ("@Sam, does this still hold?").
- **Agents** leaving comments or suggestions that humans need to see quickly after an autonomous run.

Primary flows:

1. I open a doc I have commented on before → I see an unread count on the Inbox tab → I click through threads with new activity, reply or resolve.
2. I am reading a doc → I click a comment thread in the sidebar → the editor scrolls to the anchor and the existing popover opens focused on the reply composer.
3. I am replying to a thread and want to pull someone in → I type `@` → I pick from a typeahead of known viewers and agents → they get a mention chip in the saved comment and the thread appears in their Inbox under "Mentioning me."

## Goals

- Aggregated visibility of all comment threads on a doc in a persistent right rail.
- Return-to-doc clarity: threads with activity since my last visit are visually distinct.
- Ability to reply from the sidebar without losing context (no navigation away).
- @-mention a human or agent from the reply composer and have the mentioned user see that thread surfaced in their Inbox.
- Coexistence with the existing inline popover — both work; sidebar click opens the popover pre-focused on reply.

## Non-goals (for this milestone)

- Browser push notifications, email notifications, or any out-of-app notification.
- Real user accounts, email login, or cross-device identity sync.
- `@channel` / `@here` style broadcast mentions.
- Resolving threads from the sidebar (resolve stays in the popover).
- Showing suggestions (insert/delete/replace marks) in the sidebar — comments only.
- Sidebar-initiated new threads with no anchor — creation still happens from selection in the editor.

## Target approach: right-docked rail with Doc / Inbox tabs

**Layout**

- Right-docked, collapsible rail. Default ~320px. Collapses to an icon strip on the right edge with an unread count badge.
- Two tabs at the top: **Doc** (doc-ordered list of all threads) and **Inbox** (activity-sorted, unread-first, with "Mentioning me" filter chip).
- Mobile: replace the rail with a top-bar icon that opens a full-width sheet; same row shape and tabs.

**Row shape**

- Anchor quote (truncated ~80 chars, fades out)
- Author avatar/color for most recent activity, relative time
- Reply count chip, unresolved/resolved chip, `@me` chip when the viewer is mentioned in the thread
- Agent authors show the agent identity icon (reuse `src/ui/agent-identity-icon.ts`)
- Click row → scroll editor to anchor, pulse-highlight the mark, open existing popover focused on textarea
- Expand affordance on the row → inline mini-composer with @-typeahead, posts via the same endpoint the popover uses

**Tabs behavior**

- **Doc tab**: document order (matches visual scroll). A "Show resolved" toggle, off by default. Optional "Unresolved first" sort.
- **Inbox tab**: sorted by most recent activity descending. Unread threads have a filled dot; resolved+read threads fall below the fold. Filter chips: `All`, `Mentioning me`, `From agents`. "Mark all read" action.

**Keyboard**

- `]` toggles the rail
- `j` / `k` navigate between threads when the rail is focused
- `r` focuses the reply composer for the active row
- `e` toggles resolved on the active row (once we add resolve-from-sidebar; for v1 this is deferred)

**Orphaned threads**

- Threads whose anchor quote has been deleted from the markdown are shown in a "Detached" section at the bottom of the Doc tab, with the quote preserved so the reader has context. Do not hide — data loss feels wrong.

## Identity and mentions

**Viewer ID model**

- On first interaction after the name modal, the client generates a viewer UUID, persists it in `localStorage` under `proof-share-viewer-id`, and sends it on every API request (header: `X-Proof-Viewer-Id`) and WS identify frame.
- Server associates the viewer UUID with its most recent display name per slug. The UUID is the durable identity; the name is a mutable label.
- Clearing localStorage or switching browsers produces a new viewer — explicit product decision: this is acceptable for anonymous collab.

**Mention data model**

- Each comment / reply mark gains an optional `mentions: Array<{ viewerId: string; displayName: string; startOffset: number; endOffset: number }>` field alongside `text`.
- Raw text still contains `@displayName` for fallback rendering. The structured array is authoritative for "who was mentioned" queries.
- At render time, the structured array takes precedence — mentions render as styled chips linked to the viewer UUID.

**Typeahead source**

- Union of: (a) currently connected viewers (presence), (b) recent participants (anyone who has posted a comment or reply on this doc), (c) active agents registered via `/presence`.
- Deduped by viewer UUID / agent ID. Sorted by most recent activity in this doc.
- Name collisions ("Trey" and "Trey M.") are disambiguated with a secondary line ("commented 2m ago" / "viewing now").

**Agents as mention targets**

- Agents are mentionable. A mention chip targeting an agent is a visible signal to humans ("this thread is being handed to Claude"). Mechanical agent notification flow is out of scope for v1; agents can read their mentions by calling a new `GET /api/agent/:slug/inbox?mentioning=<agentId>` endpoint.
- "Mentioning me" filter in the Inbox applies only to human viewers for v1.

## Server work

- `POST /api/agent/:slug/viewers/register` — upsert viewer UUID ↔ display name ↔ last-seen timestamp per slug.
- `GET /api/agent/:slug/viewers` — list mentionable viewers + agents for typeahead.
- `GET /api/agent/:slug/inbox` — returns threads with latest-activity timestamps, my-unread flag, my-mentioned flag. Accepts optional `mentioning=<viewerId>` filter.
- `POST /api/agent/:slug/threads/:threadId/seen` — mark this thread read for the presented viewer UUID.
- Extend `POST /api/agent/:slug/marks/comment` and `POST /api/agent/:slug/marks/reply` to accept and persist `mentions: [...]`.
- Existing `/api/agent/:slug/events/pending` feed gets a new event type on mention creation so connected clients can update unread state live.

## Success criteria

- A human returning to a doc after an agent has left comments sees a non-zero Inbox badge without reloading.
- Mentioning a connected human in a reply causes their Inbox badge to increment within one event-tick (WS or poll).
- Opening a thread from the sidebar transitions to the anchored popover without losing the thread context or reply composer focus.
- Replying from the sidebar's inline composer creates the same mark as replying from the popover (round-trip verified via `/api/agent/:slug/state`).
- A viewer who clears localStorage re-registers cleanly as a new viewer with a new name prompt, without server errors.

## Deferred for later

- Resolve thread from sidebar (keep on popover for v1).
- Unread dot sync across devices (would require linking viewer UUIDs, which wants real accounts).
- Browser push and email notifications.
- `@channel` / `@here` broadcast mentions.
- Suggestions (insert/delete/replace) in the sidebar — needs its own accept/reject UX.
- New-thread-from-sidebar without a text anchor (general-purpose doc comments).
- Collapsing consecutive same-author agent comments in Inbox (flag if agents flood in practice).
- Mobile parity with desktop keyboard shortcuts.

## Dependencies and assumptions

- Depends on the viewer-name fix landed on 2026-04-23 in `src/bridge/share-client.ts` (live re-identify on name change) — mentions rely on name and UUID propagating reliably.
- Assumes the existing marks persistence in `src/editor/plugins/marks.ts` can carry a new `mentions` field without schema migration pain (marks are stored as a JSON blob today — verify in planning).
- Assumes the collab event feed (`events/pending`) can carry a new event type without breaking current consumers.
- Assumes right-rail chrome does not conflict with the existing provenance gutter on the left edge (agent presence already lives on the left per `src/ui/agent-presence.ts`).
- Assumes viewer UUIDs carried in headers are acceptable under the current auth model (slug + optional share token) — planning should verify the server doesn't need to bind viewer UUIDs to share tokens.

## Open questions for planning

- Is it worth adding a lightweight server-side read-state index now, or can the client reconstruct "unread" from per-thread `last-seen` timestamps stored client-side on first pass? (Server-side is more work but required for cross-session unread within the same viewer UUID.)
- Should the rail remember collapsed/expanded state per slug or globally? Global is simpler; per-slug respects "some docs have lots of comments, some don't."
- Typeahead scope cap: if a doc has 50+ historic participants, do we show all or only the top 10 by recency?
