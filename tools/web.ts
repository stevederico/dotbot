/**
 * Web tools: search, fetch, grokipedia
 */

import type { ToolDefinition, JsonObject, AgentContext } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export const webTools: ToolDefinition[] = [
  // ── Web Search (Grok Responses API with web_search tool, fallback to DuckDuckGo) ──
  {
    name: "web_search",
    description:
      "Search the web for current information. Use ONLY ONCE per question to find the right URL — then use browser_navigate to read the actual page. Never call this tool multiple times for the same topic. For live or dynamic content (scores, dashboards), always prefer browser_navigate over repeated searches.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
    execute: async (input: JsonObject, signal: AbortSignal | undefined, context: AgentContext): Promise<string> => {
      const apiKey = context?.providers?.xai?.apiKey;
      const query = String(input.query);

      // Primary: Use Grok Responses API with web_search tool
      if (apiKey) {
        try {
          const res = await fetch("https://api.x.ai/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "grok-4-1-fast",
              input: [
                {
                  role: "system",
                  content: "You are a helpful search assistant. Provide concise, factual answers with sources. Format results as numbered points.",
                },
                { role: "user", content: query },
              ],
              tools: [{ type: "web_search" }],
            }),
            signal,
          });

          if (res.ok) {
            const data: unknown = await res.json();
            const output = isRecord(data) ? asArray(data.output) : [];
            const messageItem = output.find((item) => isRecord(item) && item.type === "message");
            const contentItems = isRecord(messageItem) ? asArray(messageItem.content) : [];

            const textContent = contentItems
              .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === "output_text")
              .map((c) => (typeof c.text === "string" ? c.text : ""))
              .join("\n");

            const citations = new Set<string>();
            for (const c of contentItems) {
              if (isRecord(c) && Array.isArray(c.annotations)) {
                for (const ann of c.annotations) {
                  if (isRecord(ann) && ann.type === "url_citation" && typeof ann.url === "string" && ann.url) {
                    citations.add(ann.url);
                  }
                }
              }
            }

            let result = textContent;
            if (citations.size > 0) {
              result += "\n\nSources:\n" + [...citations].slice(0, 5).map((url, i) => `${i + 1}. ${url}`).join("\n");
            }

            return result || "No results found.";
          } else {
            const errText = await res.text();
            console.error("[web_search] Grok API error:", res.status, errText);
          }
        } catch (err) {
          console.error("[web_search] Grok search failed:", err instanceof Error ? err.message : String(err));
          // Fall through to DuckDuckGo
        }
      }

      // Fallback: DuckDuckGo Instant Answer API
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": "DotBot/1.0" },
        signal,
      });

      if (!res.ok) {
        return `Search failed: ${res.status} ${res.statusText}`;
      }

      const data: unknown = await res.json();
      const parts: string[] = [];

      if (isRecord(data) && data.Abstract) {
        const abstractSource = data.AbstractSource ? ` (${String(data.AbstractSource)})` : "";
        const abstractURL = data.AbstractURL ? `\n   ${String(data.AbstractURL)}` : "";
        parts.push(`${String(data.Abstract)}${abstractSource}${abstractURL}`);
      }

      const relatedTopics = isRecord(data) ? asArray(data.RelatedTopics) : [];
      const topics = relatedTopics.filter(
        (t): t is Record<string, unknown> => isRecord(t) && Boolean(t.Text) && Boolean(t.FirstURL),
      );
      for (let i = 0; i < Math.min(topics.length, 5); i++) {
        const t = topics[i];
        if (!t) continue;
        parts.push(`${parts.length + 1}. ${String(t.Text)}\n   ${String(t.FirstURL)}`);
      }

      if (parts.length === 0) {
        return "No results found.";
      }

      const result = parts.join("\n\n");

      return result;
    },
  },

  // ── Grokipedia Search ──
  {
    name: "grokipedia_search",
    description:
      "Look up a topic on Grokipedia, a Wikipedia-like encyclopedia. Use this when the user asks to look something up on Grokipedia or wants an encyclopedic article.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The topic to look up (e.g. 'JavaScript', 'Quantum computing')",
        },
      },
      required: ["query"],
    },
    execute: async (input: JsonObject, signal: AbortSignal | undefined): Promise<string> => {
      try {
        const query = String(input.query);
        const url = `https://grokipedia.com/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "DotBot/1.0", Accept: "text/html" },
          signal,
        });

        if (res.status === 404) {
          return `No Grokipedia article found for: ${query}`;
        }
        if (!res.ok) {
          return `Grokipedia fetch failed: ${res.status} ${res.statusText}`;
        }

        let text = await res.text();
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const maxChars = 8000;
        if (text.length > maxChars) {
          text = text.slice(0, maxChars) + `\n\n... [truncated, ${text.length} chars total]`;
        }

        return text;
      } catch (err) {
        return `Error looking up Grokipedia: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Web Fetch ──
  {
    name: "web_fetch",
    description:
      "Make an HTTP request and return the response. Supports GET, POST, PUT, PATCH, and DELETE. Use this to read web pages, call APIs, or send data to external services.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method (default GET)",
        },
        body: {
          type: "string",
          description: "Request body as a JSON string (for POST/PUT/PATCH)",
        },
        headers: {
          type: "object",
          description: "Additional request headers (e.g. { \"Authorization\": \"Bearer ...\" })",
        },
      },
      required: ["url"],
    },
    execute: async (input: JsonObject, signal: AbortSignal | undefined): Promise<string> => {
      try {
        const method = (input.method ? String(input.method) : "GET").toUpperCase();
        const inputHeaders = isRecord(input.headers) ? input.headers : {};
        const reqHeaders: Record<string, string> = {
          "User-Agent": "DotBot/1.0",
          Accept: "text/html,application/json,text/plain",
        };
        for (const [k, v] of Object.entries(inputHeaders)) {
          reqHeaders[k] = typeof v === "string" ? v : String(v);
        }

        if (input.body && !reqHeaders["Content-Type"] && !reqHeaders["content-type"]) {
          reqHeaders["Content-Type"] = "application/json";
        }

        const fetchOptions: RequestInit = { method, headers: reqHeaders, signal };
        if (input.body && method !== "GET") {
          fetchOptions.body = String(input.body);
        }

        const res = await fetch(String(input.url), fetchOptions);

        if (!res.ok) {
          return `Fetch failed: ${res.status} ${res.statusText}`;
        }

        const contentType = res.headers.get("content-type") || "";
        let text: string;

        if (contentType.includes("application/json")) {
          const json: unknown = await res.json();
          text = JSON.stringify(json, null, 2);
        } else {
          text = await res.text();
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }

        const maxChars = 8000;
        if (text.length > maxChars) {
          return text.slice(0, maxChars) + `\n\n... [truncated, ${text.length} chars total]`;
        }

        return text;
      } catch (err) {
        return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
