/**
 * Message/conversation tools
 */
export const messageTools = [
  {
    name: "message_list",
    description: "List the user's message conversations.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (input, signal, context) => {
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        if (conversations.length === 0) return "No conversations found.";
        return conversations.map(c =>
          `- ${c.name || c.recipient || 'Unknown'} | ${c.lastMessage?.slice(0, 60) || 'No messages'} | ${c.updatedAt || c.createdAt || ''}`
        ).join('\n');
      } catch (err) {
        return `Error listing conversations: ${err.message}`;
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
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        let conv = conversations.find(c =>
          (c.name || c.recipient || '').toLowerCase() === input.recipient.toLowerCase()
        );
        if (!conv) {
          conv = await databaseManager.createConversation(
            dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
            { name: input.recipient, recipient: input.recipient, type: 'direct' }
          );
        }
        const convId = conv.id || conv._id?.toString();
        await databaseManager.createMessage(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, convId, userID,
          { content: input.content, sender: 'user', role: 'user' }
        );
        return `Message sent to ${input.recipient}.`;
      } catch (err) {
        return `Error sending message: ${err.message}`;
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
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        const conv = conversations.find(c =>
          (c.name || c.recipient || '').toLowerCase() === input.recipient.toLowerCase()
        );
        if (!conv) return `No conversation found with ${input.recipient}.`;
        const convId = conv.id || conv._id?.toString();
        await databaseManager.deleteConversation(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, convId, userID
        );
        return `Conversation with ${input.recipient} deleted.`;
      } catch (err) {
        return `Error deleting conversation: ${err.message}`;
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
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        const conversations = await databaseManager.findConversations(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID
        );
        const conv = conversations.find(c =>
          (c.name || c.recipient || '').toLowerCase() === input.recipient.toLowerCase()
        );
        if (!conv) return `No conversation found with ${input.recipient}.`;
        const convId = conv.id || conv._id?.toString();
        const messages = await databaseManager.findMessages(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, convId, userID, input.limit || 20
        );
        if (!messages || messages.length === 0) return `No messages with ${input.recipient}.`;
        return messages.map(m =>
          `[${m.sender || m.role || 'unknown'}] ${m.content}${m.createdAt ? ' — ' + new Date(m.createdAt).toLocaleString() : ''}`
        ).join('\n');
      } catch (err) {
        return `Error reading messages: ${err.message}`;
      }
    },
  },
];
