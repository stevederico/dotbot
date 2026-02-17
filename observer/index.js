/**
 * Browser Observer — in-memory snapshot store and agent tool.
 *
 * The frontend pushes structured browser-state snapshots via POST /api/agent/observer.
 * The agent reads the latest snapshot via the `browser_observe` tool to understand
 * what the user is currently doing in the browser.
 */

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** @type {Map<string, Object>} userID → { ...snapshot, receivedAt } */
const snapshots = new Map();

/**
 * Store the latest browser snapshot for a user.
 *
 * @param {string} userID - Authenticated user ID
 * @param {Object} snapshot - Structured browser state from the frontend
 */
export function storeSnapshot(userID, snapshot) {
  snapshots.set(userID, { ...snapshot, receivedAt: Date.now() });
}

/**
 * Retrieve the latest snapshot for a user, or null if stale/missing.
 *
 * @param {string} userID - Authenticated user ID
 * @returns {Object|null} Snapshot with receivedAt, or null
 */
export function getSnapshot(userID) {
  const entry = snapshots.get(userID);
  if (!entry) return null;
  if (Date.now() - entry.receivedAt > SNAPSHOT_TTL_MS) {
    snapshots.delete(userID);
    return null;
  }
  return entry;
}

/**
 * Remove a user's snapshot (cleanup on logout, etc.).
 *
 * @param {string} userID - Authenticated user ID
 */
export function clearSnapshot(userID) {
  snapshots.delete(userID);
}

/**
 * Format a snapshot into plain-text for LLM consumption.
 *
 * @param {Object} snap - Snapshot object from the store
 * @param {boolean} includeActions - Whether to include recent actions
 * @returns {string} Human-readable state description
 */
function formatSnapshot(snap, includeActions = true) {
  const ageSec = Math.round((Date.now() - snap.timestamp) / 1000);
  const lines = [];

  lines.push(`Browser state (${ageSec}s ago):`);
  lines.push('');

  // Windows
  if (snap.windows && snap.windows.length > 0) {
    lines.push(`Open apps (${snap.windowCount || snap.windows.length}):`);
    for (const w of snap.windows) {
      const focus = w.isFocused ? ' [focused]' : '';
      lines.push(`  - ${w.app}${w.title ? ': ' + w.title : ''}${focus}`);
    }
  } else {
    lines.push('No apps open.');
  }

  if (snap.focusedApp) {
    lines.push(`Focused: ${snap.focusedApp}`);
  }

  // Docked panel
  if (snap.isDottieDocked) {
    lines.push('DotBot panel: docked (sidebar)');
  }

  // Input bar
  if (snap.isInputElevated) {
    lines.push(`Input bar: elevated${snap.inputValue ? ' — "' + snap.inputValue + '"' : ''}`);
  }

  // Voice
  if (snap.voiceState && snap.voiceState !== 'idle') {
    lines.push(`Voice: ${snap.voiceState}`);
  }

  // Streaming
  if (snap.isStreaming) {
    lines.push('Agent: streaming response');
  }

  // Last tool call
  if (snap.lastToolCall) {
    const tc = snap.lastToolCall;
    const tcAge = Math.round((Date.now() - tc.timestamp) / 1000);
    lines.push(`Last tool: ${tc.name} (${tc.status}, ${tcAge}s ago)`);
  }

  // Messages
  if (snap.messageCount > 0) {
    lines.push(`Messages in session: ${snap.messageCount}`);
  }

  // Provider/model
  if (snap.currentProvider || snap.currentModel) {
    lines.push(`Model: ${snap.currentProvider || '?'}/${snap.currentModel || '?'}`);
  }

  // Layout + dock
  lines.push(`Layout: ${snap.layoutMode || 'desktop'}`);
  if (snap.dockApps && snap.dockApps.length > 0) {
    lines.push(`Dock: ${snap.dockApps.join(', ')}`);
  }

  // Viewport
  if (snap.viewport) {
    lines.push(`Viewport: ${snap.viewport.width}x${snap.viewport.height}`);
  }

  // Recent actions
  if (includeActions && snap.recentActions && snap.recentActions.length > 0) {
    lines.push('');
    lines.push('Recent actions:');
    for (const a of snap.recentActions) {
      const aAge = Math.round((Date.now() - a.timestamp) / 1000);
      const detail = a.app ? ` (${a.app})` : a.tool ? ` (${a.tool})` : '';
      lines.push(`  - ${a.action}${detail} — ${aAge}s ago`);
    }
  }

  return lines.join('\n');
}

/** Agent tool definitions for the browser observer. */
export const observerTools = [
  {
    name: 'browser_observe',
    description:
      "See what the user is currently doing in Dottie OS — open apps, focused window, voice state, recent actions. " +
      "Call this when you need context about the user's current activity, or when they reference 'this', 'what I'm looking at', or 'current'.",
    parameters: {
      type: 'object',
      properties: {
        include_actions: {
          type: 'boolean',
          description: 'Include recent user actions (default true)',
        },
      },
    },
    execute: async (input, signal, context) => {
      if (!context?.userID) return 'Error: user context not available';
      const snap = getSnapshot(context.userID);
      if (!snap) return 'No browser state available. The user may have the tab in the background or just opened the page.';
      const includeActions = input.include_actions !== false;
      return formatSnapshot(snap, includeActions);
    },
  },
];
