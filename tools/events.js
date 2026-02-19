/**
 * Event Analytics Tools
 *
 * Query and summarize user activity events for usage analytics.
 * Answers questions like "how many messages did I send this week?"
 * or "what tools do I use most?"
 */

export const eventTools = [
  {
    name: "event_query",
    description:
      "Query user activity events with filters. Returns recent events matching the criteria. " +
      "Use this to find specific events like messages sent, tool calls, goals created, etc.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Event type filter: message_sent, message_received, tool_call, goal_created, goal_completed, trigger_fired",
        },
        startDate: {
          type: "string",
          description: "ISO date start filter, e.g. '2026-02-01'",
        },
        endDate: {
          type: "string",
          description: "ISO date end filter, e.g. '2026-02-18'",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 50, max: 200)",
        },
      },
    },
    execute: async (input, signal, context) => {
      if (!context?.eventStore) return "Error: eventStore not available";
      try {
        const limit = Math.min(input.limit || 50, 200);
        const events = await context.eventStore.query({
          userId: context.userID,
          type: input.type,
          startDate: input.startDate,
          endDate: input.endDate,
          limit,
        });

        if (events.length === 0) {
          const filters = [];
          if (input.type) filters.push(`type=${input.type}`);
          if (input.startDate) filters.push(`from ${input.startDate}`);
          if (input.endDate) filters.push(`to ${input.endDate}`);
          return filters.length > 0
            ? `No events found matching: ${filters.join(", ")}`
            : "No events recorded yet.";
        }

        // Format events for display
        return events.map((e) => {
          const date = new Date(e.timestamp).toISOString().split("T")[0];
          const time = new Date(e.timestamp).toISOString().split("T")[1].slice(0, 5);
          const dataStr = e.data && Object.keys(e.data).length > 0
            ? ` (${JSON.stringify(e.data)})`
            : "";
          return `${date} ${time} - ${e.type}${dataStr}`;
        }).join("\n");
      } catch (err) {
        return `Error querying events: ${err.message}`;
      }
    },
  },

  {
    name: "events_summary",
    description:
      "Get aggregated usage statistics and analytics. Shows counts by event type, " +
      "time period breakdowns, and tool usage patterns. Use this to answer questions " +
      "like 'how many messages this week?' or 'what are my most used tools?'",
    parameters: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "ISO date start, e.g. '2026-02-01'",
        },
        endDate: {
          type: "string",
          description: "ISO date end, e.g. '2026-02-18'",
        },
        groupBy: {
          type: "string",
          enum: ["type", "day", "week", "month"],
          description: "How to group results: by type (default), day, week, or month",
        },
      },
    },
    execute: async (input, signal, context) => {
      if (!context?.eventStore) return "Error: eventStore not available";
      try {
        const summary = await context.eventStore.summary({
          userId: context.userID,
          startDate: input.startDate,
          endDate: input.endDate,
          groupBy: input.groupBy || "type",
        });

        if (summary.total === 0) {
          return "No events recorded yet.";
        }

        let output = `Total Events: ${summary.total}\n\n`;

        // Format breakdown based on groupBy
        const groupBy = input.groupBy || "type";
        if (groupBy === "type") {
          output += "By Type:\n";
          for (const [type, count] of Object.entries(summary.breakdown)) {
            output += `  ${type}: ${count}\n`;
          }
        } else {
          output += `By ${groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}:\n`;
          for (const item of summary.breakdown) {
            output += `  ${item.period}: ${item.count}\n`;
          }
        }

        // Tool usage breakdown if available
        if (summary.toolUsage && Object.keys(summary.toolUsage).length > 0) {
          output += "\nTool Usage:\n";
          // Sort by count descending
          const sorted = Object.entries(summary.toolUsage)
            .sort((a, b) => b[1] - a[1]);
          for (const [tool, count] of sorted) {
            output += `  ${tool}: ${count}\n`;
          }
        }

        return output.trim();
      } catch (err) {
        return `Error generating summary: ${err.message}`;
      }
    },
  },
];
