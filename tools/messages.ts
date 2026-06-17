/**
 * Message/conversation tools
 */
import type {
  AgentContext,
  DbConfig,
  ToolDefinition,
} from "../types.js";

/** A conversation record returned by the database manager. */
interface Conversation {
  id?: string;
  _id?: { toString(): string };
  name?: string;
  recipient?: string;
  lastMessage?: string;
  updatedAt?: string;
  createdAt?: string;
}

/** A message record returned by the database manager. */
interface MessageRecord {
  content: string;
  sender?: string;
  role?: string;
  createdAt?: string | number | Date;
}

/**
 * Database manager surface used by the message tools. Modeled structurally
 * from usage here; the shared DatabaseManager interface covers the virtual
 * filesystem methods, while these cover conversations/messages.
 */
interface MessageDatabaseManager {
  findConversations(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
  ): Promise<Conversation[]>;
  createConversation(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    data: { name: string; recipient: string; type: string },
  ): Promise<Conversation>;
  createMessage(
    dbType: string,
    db: string,
    connectionString: string,
    convId: string,
    userID: string,
    data: { content: string; sender: string; role: string },
  ): Promise<unknown>;
  deleteConversation(
    dbType: string,
    db: string,
    connectionString: string,
    convId: string,
    userID: string,
  ): Promise<unknown>;
  findMessages(
    dbType: string,
    db: string,
    connectionString: string,
    convId: string,
    userID: string,
    limit: number,
  ): Promise<MessageRecord[] | null>;
}

/** Context shape after narrowing for the message tools. */
interface MessageContext {
  databaseManager: MessageDatabaseManager;
  dbConfig: DbConfig;
  userID: string;
}

/** Runtime guard: does the value expose the message database methods? */
function isMessageDatabaseManager(
  value: unknown,
): value is MessageDatabaseManager {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "findConversations") === "function" &&
    typeof Reflect.get(value, "createConversation") === "function" &&
    typeof Reflect.get(value, "createMessage") === "function" &&
    typeof Reflect.get(value, "deleteConversation") === "function" &&
    typeof Reflect.get(value, "findMessages") === "function"
  );
}

/**
 * Narrow an AgentContext into the message-tool context, or return null when
 * the database manager is not available.
 */
function resolveContext(context: AgentContext): MessageContext | null {
  const dm = context.databaseManager;
  if (!isMessageDatabaseManager(dm)) return null;
  const dbConfig = context.dbConfig ?? { dbType: "", db: "", connectionString: "" };
  return {
    databaseManager: dm,
    dbConfig,
    userID: String(context.userID),
  };
}

/** Extract a string error message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const messageTools: ToolDefinition[] = [
  {
    name: "message_list",
    description: "List the user's message conversations.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (input, signal, context) => {
      const ctx = resolveContext(context);
      if (!ctx) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = ctx;
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        if (conversations.length === 0) return "No conversations found.";
        return conversations.map(c =>
          `- ${c.name || c.recipient || 'Unknown'} | ${c.lastMessage?.slice(0, 60) || 'No messages'} | ${c.updatedAt || c.createdAt || ''}`
        ).join('\n');
      } catch (err) {
        return `Error listing conversations: ${errorMessage(err)}`;
      }
    },
  },

  {
    name: "message_send",
    description: "Send a message in a conversation. Creates a new conversation if one doesn't exist with the recipient.",
    parameters: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Recipient name or ID" },
        content: { type: "string", description: "Message content" },
      },
      required: ["recipient", "content"],
    },
    execute: async (input, signal, context) => {
      const ctx = resolveContext(context);
      if (!ctx) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = ctx;
        const recipient = String(input.recipient);
        const content = String(input.content);
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        let conv = conversations.find(c =>
          (c.name || c.recipient || '').toLowerCase() === recipient.toLowerCase()
        );
        if (!conv) {
          conv = await databaseManager.createConversation(
            dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
            { name: recipient, recipient: recipient, type: 'direct' }
          );
        }
        const convId = conv.id || conv._id?.toString();
        await databaseManager.createMessage(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, String(convId), userID,
          { content: content, sender: 'user', role: 'user' }
        );
        return `Message sent to ${recipient}.`;
      } catch (err) {
        return `Error sending message: ${errorMessage(err)}`;
      }
    },
  },

  {
    name: "message_delete",
    description: "Delete an entire conversation with a specific person.",
    parameters: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Person's name whose conversation to delete" },
      },
      required: ["recipient"],
    },
    execute: async (input, signal, context) => {
      const ctx = resolveContext(context);
      if (!ctx) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = ctx;
        const recipient = String(input.recipient);
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        const conv = conversations.find(c =>
          (c.name || c.recipient || '').toLowerCase() === recipient.toLowerCase()
        );
        if (!conv) return `No conversation found with ${recipient}.`;
        const convId = conv.id || conv._id?.toString();
        await databaseManager.deleteConversation(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, String(convId), userID
        );
        return `Conversation with ${recipient} deleted.`;
      } catch (err) {
        return `Error deleting conversation: ${errorMessage(err)}`;
      }
    },
  },

  {
    name: "message_read",
    description: "Read messages in a conversation with a specific person.",
    parameters: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Person's name to read messages with" },
        limit: { type: "number", description: "Max messages to return (default 20)" },
      },
      required: ["recipient"],
    },
    execute: async (input, signal, context) => {
      const ctx = resolveContext(context);
      if (!ctx) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = ctx;
        const recipient = String(input.recipient);
        const limit = (typeof input.limit === "number" ? input.limit : 0) || 20;
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        const conv = conversations.find(c =>
          (c.name || c.recipient || '').toLowerCase() === recipient.toLowerCase()
        );
        if (!conv) return `No conversation found with ${recipient}.`;
        const convId = conv.id || conv._id?.toString();
        const messages = await databaseManager.findMessages(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, String(convId), userID, limit
        );
        if (!messages || messages.length === 0) return `No messages with ${recipient}.`;
        return messages.map(m =>
          `[${m.sender || m.role || 'unknown'}] ${m.content}${m.createdAt ? ' — ' + new Date(m.createdAt).toLocaleString() : ''}`
        ).join('\n');
      } catch (err) {
        return `Error reading messages: ${errorMessage(err)}`;
      }
    },
  },
];
