/**
 * Tests for U7 — mobile sheet variant CSS presence and keyboard
 * shortcut semantics.
 *
 * DOM rendering tests for the keyboard handlers are deferred to
 * browser smoke coverage (jsdom is not in the devDeps). This file
 * guards the shape of the shortcuts: key mappings, edit-context
 * bypass rules, and shortcut scope.
 *
 * The test reads the source and verifies the required handlers and
 * CSS selectors are present. Lightweight, but guards against
 * accidental removal during refactors.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run(): Promise<void> {
  const sidebarSource = readFileSync(
    path.join(__dirname, '..', 'ui', 'comments-sidebar.ts'),
    'utf8',
  );

  // Required keyboard shortcuts.
  assert.match(sidebarSource, /event\.key === '\]'/, 'rail-toggle shortcut present');
  assert.match(sidebarSource, /event\.key === 'j' \|\| event\.key === 'ArrowDown'/, 'j / ArrowDown shortcut present');
  assert.match(sidebarSource, /event\.key === 'k' \|\| event\.key === 'ArrowUp'/, 'k / ArrowUp shortcut present');
  assert.match(sidebarSource, /event\.key === 'r'/, 'r shortcut present');
  assert.match(sidebarSource, /event\.key === 'Escape'/, 'Escape handler present');

  // Edit-context guard: shortcuts must check isEditingTarget before firing.
  assert.match(sidebarSource, /function isEditingTarget/, 'isEditingTarget helper exported');
  assert.match(sidebarSource, /if \(isEditingTarget\(event\.target\)\)/, 'editing guard applied in keyboard handler');

  // Keyboard listener is removed on destroy — no leak.
  assert.match(sidebarSource, /document\.removeEventListener\('keydown', onKeyDown\)/, 'keyboard listener cleaned up on destroy');

  // Mobile sheet CSS present.
  const indexHtml = readFileSync(
    path.join(__dirname, '..', 'index.html'),
    'utf8',
  );
  assert.match(indexHtml, /@media \(max-width: 900px\)/, 'mobile breakpoint present');
  // The sidebar should transition to a bottom sheet, not hide.
  const mobileBlock = indexHtml.split('@media (max-width: 900px)')[1];
  assert.ok(mobileBlock, 'mobile media block present');
  assert.match(mobileBlock, /\.comments-sidebar\s*{[^}]*bottom: 0/, 'bottom-docked sheet on mobile');
  assert.match(mobileBlock, /\.comments-sidebar-panel\s*{[^}]*border-radius: 14px 14px 0 0/, 'sheet has rounded top corners');

  console.log('comments-sidebar-keyboard.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
