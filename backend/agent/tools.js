// agent/tools.js
// Tool registry. Each tool has a name, description, parameters schema, and execute function.
// The agent loop picks these up automatically.
// Ported from Deno to Node.js — all Deno APIs replaced with node:fs/promises, node:os, node:child_process.

import { readFile, writeFile, mkdir, unlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { memoryTools } from "./memory.js";
import { cronTools } from "./cron.js";

const execFileAsync = promisify(execFile);

/**
 * All available tools. Add new tools by pushing to this array.
 * Each tool needs:
 *   - name: string (snake_case)
 *   - description: string (tell the model what it does)
 *   - parameters: JSON Schema object
 *   - execute: async function (input, signal?) => string
 */
export const tools = [
  // Memory tools (save + search across conversations)
  ...memoryTools,

  // Cron tools (schedule, list, cancel tasks)
  ...cronTools,

  // ── Web Search (Brave Search API — free tier: 2,000 queries/mo) ──
  {
    name: "web_search",
    description:
      "Search the web for current information. Use this when the user asks about recent events, facts you're unsure about, or anything that needs up-to-date information.",
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
    execute: async (input, signal) => {
      const apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) {
        return "Error: BRAVE_API_KEY not set. Get a free key at https://api.search.brave.com/";
      }

      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=5`;
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });

      if (!res.ok) {
        return `Search failed: ${res.status} ${res.statusText}`;
      }

      const data = await res.json();
      const results = data.web?.results || [];

      if (results.length === 0) {
        return "No results found.";
      }

      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || ""}`)
        .join("\n\n");
    },
  },

  // ── File Read ──
  {
    name: "file_read",
    description:
      "Read the contents of a file from the ~/.dotbot directory. Use this when the user asks you to look at, review, or analyze a file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to ~/.dotbot. e.g. 'notes/todo.md' or 'data/config.json'",
        },
      },
      required: ["path"],
    },
    execute: async (input) => {
      try {
        const home = homedir();
        const basePath = `${home}/.dotbot`;
        const fullPath = `${basePath}/${input.path}`.replace(/\/+/g, "/");

        // Security: resolve and verify path stays inside ~/.dotbot
        const resolved = await realpath(fullPath).catch(() => fullPath);
        if (!resolved.startsWith(basePath)) {
          return "Error: access denied. Files must be inside ~/.dotbot";
        }

        const content = await readFile(resolved, "utf-8");

        const maxChars = 10000;
        if (content.length > maxChars) {
          return (
            content.slice(0, maxChars) +
            `\n\n... [truncated, file is ${content.length} chars total]`
          );
        }

        return content;
      } catch (err) {
        return `Error reading file: ${err.message}`;
      }
    },
  },

  // ── File Write ──
  {
    name: "file_write",
    description:
      "Write content to a file in the ~/.dotbot directory. Use this when the user asks you to create or save a file. Directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to ~/.dotbot. e.g. 'notes/todo.md'",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
    execute: async (input) => {
      try {
        const home = homedir();
        const basePath = `${home}/.dotbot`;
        const fullPath = `${basePath}/${input.path}`.replace(/\/+/g, "/");

        // Security: check path doesn't escape ~/.dotbot
        if (fullPath.includes("..")) {
          return "Error: access denied. Path cannot contain '..'";
        }

        // Create directories if needed
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        await mkdir(dir, { recursive: true }).catch(() => {});

        await writeFile(fullPath, input.content, "utf-8");
        return `Wrote ${input.content.length} chars to ~/.dotbot/${input.path}`;
      } catch (err) {
        return `Error writing file: ${err.message}`;
      }
    },
  },

  // ── Run Code (JavaScript via Node.js subprocess) ──
  {
    name: "run_code",
    description:
      "Execute JavaScript code and return the output. Use this for calculations, data processing, or when the user asks you to run code. The code runs in a Node.js subprocess.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript code to execute. Use console.log() for output.",
        },
      },
      required: ["code"],
    },
    execute: async (input) => {
      const tmpFile = `/tmp/dotbot_code_${Date.now()}.mjs`;

      try {
        // Write code to temp file
        await writeFile(tmpFile, input.code, "utf-8");

        // Run in Node.js subprocess with timeout
        const { stdout, stderr } = await execFileAsync("node", [tmpFile], {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });

        // Clean up
        await unlink(tmpFile).catch(() => {});

        if (stderr) {
          return `Stderr:\n${stderr}\n\nStdout:\n${stdout}`;
        }

        return stdout || "(no output)";
      } catch (err) {
        // Clean up on error
        await unlink(tmpFile).catch(() => {});

        if (err.killed) {
          return "Error: code execution timed out (10s limit)";
        }
        if (err.stderr) {
          return `Exit code ${err.code}\n\nStderr:\n${err.stderr}\n\nStdout:\n${err.stdout || ""}`;
        }
        return `Error executing code: ${err.message}`;
      }
    },
  },

  // ── Web Fetch (read a URL) ──
  {
    name: "web_fetch",
    description:
      "Fetch the content of a web page and return its text. Use this when you need to read a specific URL the user mentions.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
      },
      required: ["url"],
    },
    execute: async (input, signal) => {
      try {
        const res = await fetch(input.url, {
          headers: {
            "User-Agent": "DotBot/1.0",
            Accept: "text/html,application/json,text/plain",
          },
          signal,
        });

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
          // Strip HTML tags for readability
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }

        // Truncate
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
