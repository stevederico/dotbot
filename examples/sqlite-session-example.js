/**
 * SQLiteSessionStore Usage Example
 *
 * Demonstrates how to use SQLite as a session storage backend
 * for the @dottie/agent library. Requires Node.js 22.5+.
 */

import { createAgent, SQLiteSessionStore, coreTools } from '@dottie/agent';

// Initialize SQLite session store
const sessionStore = new SQLiteSessionStore();
await sessionStore.init('./sessions.db', {
  // Optional: Fetch user preferences from your database
  prefsFetcher: async (userId) => {
    // Example: fetch from a user database
    return {
      agentName: 'Dottie',
      agentPersonality: 'helpful and concise',
    };
  },
  // Optional: Ensure user heartbeat for cron tasks
  heartbeatEnsurer: async (userId) => {
    // Example: update last_seen timestamp in user database
    console.log(`User ${userId} active`);
    return null;
  },
});

// Create agent with SQLite session storage
const agent = createAgent({
  sessionStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  },
  tools: coreTools,
});

// Example 1: Create a new session
const session = await agent.createSession('user-123', 'claude-sonnet-4-5', 'anthropic');
console.log('Created session:', session.id);

// Example 2: Chat with the agent
for await (const event of agent.chat({
  sessionId: session.id,
  message: 'What can you help me with?',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
})) {
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
console.log('\n');

// Example 3: List all sessions for a user
const sessions = await sessionStore.listSessions('user-123');
console.log('User sessions:', sessions);

// Example 4: Get or create default session
const defaultSession = await sessionStore.getOrCreateDefaultSession('user-123');
console.log('Default session:', defaultSession.id);

// Example 5: Clear session history
await sessionStore.clearSession(session.id);
console.log('Session cleared');

// Example 6: Delete a session
await sessionStore.deleteSession(session.id, 'user-123');
console.log('Session deleted');
