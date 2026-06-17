/**
 * User notification tool
 */
import type {
  AgentContext,
  DbConfig,
  ToolDefinition,
} from "../types.js";

/**
 * Database manager surface used by the notify tool. Modeled structurally from
 * usage here; the shared DatabaseManager interface covers the virtual
 * filesystem methods, while this covers notifications.
 */
interface NotifyDatabaseManager {
  createNotification(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    data: { title: string; body: string; type: string },
  ): Promise<unknown>;
}

/** Context shape after narrowing for the notify tool. */
interface NotifyContext {
  databaseManager: NotifyDatabaseManager;
  dbConfig: DbConfig;
  userID: string;
}

/** Runtime guard: does the value expose the notification method? */
function isNotifyDatabaseManager(
  value: unknown,
): value is NotifyDatabaseManager {
  if (typeof value !== "object" || value === null) return false;
  if (!("createNotification" in value)) return false;
  const { createNotification }: Record<"createNotification", unknown> = value;
  return typeof createNotification === "function";
}

/**
 * Narrow an AgentContext into the notify-tool context, or return null when the
 * database manager is not available.
 */
function resolveContext(context: AgentContext): NotifyContext | null {
  const dm = context.databaseManager;
  if (!isNotifyDatabaseManager(dm)) return null;
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

export const notifyTools: ToolDefinition[] = [
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
      const ctx = resolveContext(context);
      if (!ctx) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = ctx;
        const title = String(input.title);
        const body = String(input.body);
        const type = typeof input.type === "string" && input.type ? input.type : "info";
        await databaseManager.createNotification(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString,
          userID,
          { title, body, type }
        );
        return `Notification sent: "${title}"`;
      } catch (err) {
        return `Error sending notification: ${errorMessage(err)}`;
      }
    },
  },
];
