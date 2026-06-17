import { writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

import type { ToolDefinition, JsonObject } from "../types.js";

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Code execution tool: run JavaScript in a sandboxed Node.js subprocess
 */
export const codeTools: ToolDefinition[] = [
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
    execute: async (input: JsonObject): Promise<string> => {
      const tmpFile = `/tmp/dotbot_code_${Date.now()}.mjs`;

      try {
        await writeFile(tmpFile, String(input.code), "utf-8");

        // Allowlist-only env
        const cleanEnv: Record<string, string | undefined> = {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR || '/tmp',
        };

        // Sandboxed Node.js subprocess with permission model
        const { stdout, stderr } = await execFileAsync(
          "node",
          [
            "--experimental-permission",
            `--allow-fs-read=${tmpFile}`,
            `--allow-fs-write=${tmpFile}`,
            tmpFile,
          ],
          {
            timeout: 10000,
            maxBuffer: 1024 * 1024,
            env: cleanEnv,
          },
        );

        await unlink(tmpFile).catch(() => {});

        if (stderr) {
          return `Stderr:\n${stderr}\n\nStdout:\n${stdout}`;
        }

        return stdout || "(no output)";
      } catch (err: unknown) {
        await unlink(tmpFile).catch(() => {});

        if (isRecord(err) && err.killed) {
          return "Error: code execution timed out (10s limit)";
        }
        if (isRecord(err) && err.stderr) {
          return `Exit code ${String(err.code)}\n\nStderr:\n${String(err.stderr)}\n\nStdout:\n${err.stdout ? String(err.stdout) : ""}`;
        }
        return `Error executing code: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
