/**
 * Web tools: search, fetch, grokipedia
 */

export const webTools = [
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
    execute: async (input, signal, context) => {
      const apiKey = context?.providers?.xai?.apiKey;

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
                { role: "user", content: input.query },
              ],
              tools: [{ type: "web_search" }],
            }),
            signal,
          });

          if (res.ok) {
            const data = await res.json();
            const messageItem = (data.output || []).find(item => item.type === "message");
            const contentItems = messageItem?.content || [];

            const textContent = contentItems
              .filter(c => c.type === "output_text")
              .map(c => c.text)
              .join("\n");

            const citations = new Set();
            for (const c of contentItems) {
              if (c.annotations) {
                for (const ann of c.annotations) {
                  if (ann.type === "url_citation" && ann.url) {
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
          console.error("[web_search] Grok search failed:", err.message);
          // Fall through to DuckDuckGo
        }
      }

      // Fallback: DuckDuckGo Instant Answer API
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_html=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": "DotBot/1.0" },
        signal,
      });

      if (!res.ok) {
        return `Search failed: ${res.status} ${res.statusText}`;
      }

      const data = await res.json();
      const parts = [];

      if (data.Abstract) {
        parts.push(`${data.Abstract}${data.AbstractSource ? ` (${data.AbstractSource})` : ""}${data.AbstractURL ? `\n   ${data.AbstractURL}` : ""}`);
      }

      const topics = (data.RelatedTopics || []).filter((t) => t.Text && t.FirstURL);
      for (let i = 0; i < Math.min(topics.length, 5); i++) {
        const t = topics[i];
        parts.push(`${parts.length + 1}. ${t.Text}\n   ${t.FirstURL}`);
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
    execute: async (input, signal, context) => {
      try {
        const url = `https://grokipedia.com/search?q=${encodeURIComponent(input.query)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "DotBot/1.0", Accept: "text/html" },
          signal,
        });

        if (res.status === 404) {
          return `No Grokipedia article found for: ${input.query}`;
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
        return `Error looking up Grokipedia: ${err.message}`;
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
    execute: async (input, signal, context) => {
      try {
        const method = (input.method || "GET").toUpperCase();
        const reqHeaders = {
          "User-Agent": "DotBot/1.0",
          Accept: "text/html,application/json,text/plain",
          ...(input.headers || {}),
        };

        if (input.body && !reqHeaders["Content-Type"] && !reqHeaders["content-type"]) {
          reqHeaders["Content-Type"] = "application/json";
        }

        const fetchOptions = { method, headers: reqHeaders, signal };
        if (input.body && method !== "GET") {
          fetchOptions.body = input.body;
        }

        const res = await fetch(input.url, fetchOptions);

        if (!res.ok) {
          return `Fetch failed: ${res.status} ${res.statusText}`;
        }

        const contentType = res.headers.get("content-type") || "";
        let text;

        if (contentType.includes("application/json")) {
          const json = await res.json();
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
        return `Error fetching URL: ${err.message}`;
      }
    },
  },
];
