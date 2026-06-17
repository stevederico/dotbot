/**
 * Event Analytics Tools
 *
 * Query and summarize user activity events for usage analytics.
 * Answers questions like "how many messages did I send this week?"
 * or "what tools do I use most?"
 */

import type {
  AgentContext,
  EventQueryParams,
  EventSummaryParams,
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolResult,
} from "../types.js";

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Recognized groupBy values for events_summary. */
type SummaryGroupBy = NonNullable<EventSummaryParams["groupBy"]>;

/** A period/count row used when grouping by day/week/month. */
interface PeriodCount {
  period: string;
  count: number;
}

/** Type guard for a plain (non-array) object indexable by string. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Coerce an unknown value to a finite number, defaulting to 0. */
function asCount(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Narrow an unknown breakdown entry to a PeriodCount row. */
function toPeriodCount(value: unknown): PeriodCount {
  if (isRecord(value)) {
    return {
      period: typeof value.period === "string" ? value.period : String(value.period),
      count: asCount(value.count),
    };
  }
  return { period: String(value), count: 0 };
}

export const eventTools: ToolDefinition[] = [
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
            "Event type filter: message_sent, message_received, tool_call, task_created, task_completed, trigger_fired",
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
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const eventStore = context?.eventStore;
      if (!eventStore) return "Error: eventStore not available";
      try {
        const limit = Math.min(typeof input.limit === "number" ? input.limit : 50, 200);
        const params: EventQueryParams = {
          userId: context.userID ?? "",
          type: typeof input.type === "string" ? input.type : undefined,
          startDate: typeof input.startDate === "string" ? input.startDate : undefined,
          endDate: typeof input.endDate === "string" ? input.endDate : undefined,
          limit,
        };
        const events = await eventStore.query(params);

        if (events.length === 0) {
          const filters: string[] = [];
          if (input.type) filters.push(`type=${input.type}`);
          if (input.startDate) filters.push(`from ${input.startDate}`);
          if (input.endDate) filters.push(`to ${input.endDate}`);
          return filters.length > 0
            ? `No events found matching: ${filters.join(", ")}`
            : "No events recorded yet.";
        }

        // Format events for display
        return events.map((e) => {
          const iso = new Date(e.timestamp).toISOString();
          const [datePart, timePart = ""] = iso.split("T");
          const date = datePart ?? "";
          const time = timePart.slice(0, 5);
          const dataStr = e.data && Object.keys(e.data).length > 0
            ? ` (${JSON.stringify(e.data)})`
            : "";
          return `${date} ${time} - ${e.type}${dataStr}`;
        }).join("\n");
      } catch (err) {
        return `Error querying events: ${errMessage(err)}`;
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
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const eventStore = context?.eventStore;
      if (!eventStore) return "Error: eventStore not available";
      try {
        const groupBy: SummaryGroupBy = isGroupBy(input.groupBy) ? input.groupBy : "type";
        const params: EventSummaryParams = {
          userId: context.userID ?? "",
          startDate: typeof input.startDate === "string" ? input.startDate : undefined,
          endDate: typeof input.endDate === "string" ? input.endDate : undefined,
          groupBy,
        };
        const summary: Record<string, unknown> = await eventStore.summary(params);

        if (asCount(summary.total) === 0) {
          return "No events recorded yet.";
        }

        let output = `Total Events: ${asCount(summary.total)}\n\n`;

        // Format breakdown based on groupBy
        const breakdown: unknown = summary.breakdown;
        if (groupBy === "type") {
          output += "By Type:\n";
          if (breakdown !== null && typeof breakdown === "object" && !Array.isArray(breakdown)) {
            for (const [type, count] of Object.entries(breakdown)) {
              output += `  ${type}: ${count}\n`;
            }
          }
        } else {
          output += `By ${groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}:\n`;
          const rows: unknown[] = Array.isArray(breakdown) ? breakdown : [];
          for (const item of rows) {
            const { period, count } = toPeriodCount(item);
            output += `  ${period}: ${count}\n`;
          }
        }

        // Tool usage breakdown if available
        const toolUsage: unknown = summary.toolUsage;
        if (toolUsage !== null && typeof toolUsage === "object" && !Array.isArray(toolUsage) && Object.keys(toolUsage).length > 0) {
          output += "\nTool Usage:\n";
          // Sort by count descending
          const sorted = Object.entries(toolUsage)
            .sort((a, b) => asCount(b[1]) - asCount(a[1]));
          for (const [tool, count] of sorted) {
            output += `  ${tool}: ${count}\n`;
          }
        }

        return output.trim();
      } catch (err) {
        return `Error generating summary: ${errMessage(err)}`;
      }
    },
  },
];

/** Type guard for the events_summary groupBy enum values. */
function isGroupBy(value: JsonValue | undefined): value is SummaryGroupBy {
  return value === "type" || value === "day" || value === "week" || value === "month";
}
