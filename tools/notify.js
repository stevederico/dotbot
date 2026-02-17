/**
 * User notification tool
 */
export const notifyTools = [
  {
    name: "notify_user",
    description:
      "Send a notification to the user. Use this during heartbeat or scheduled tasks to proactively inform the user of something useful. The notification appears in their notification center.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short notification title, e.g. 'Weather Alert' or 'Task Reminder'",
        },
        body: {
          type: "string",
          description: "Notification body text with the details",
        },
        type: {
          type: "string",
          description: "Notification type: 'info', 'reminder', 'alert', or 'heartbeat'. Defaults to 'info'.",
        },
      },
      required: ["title", "body"],
    },
    execute: async (input, signal, context) => {
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        await databaseManager.createNotification(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString,
          userID,
          { title: input.title, body: input.body, type: input.type || "info" }
        );
        return `Notification sent: "${input.title}"`;
      } catch (err) {
        return `Error sending notification: ${err.message}`;
      }
    },
  },
];
