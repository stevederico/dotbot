import { writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Code execution tool: run JavaScript in a sandboxed Node.js subprocess
 */
export const codeTools = [
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
    execute: async (input, signal, context) => {
      const tmpFile = `/tmp/dotbot_code_${Date.now()}.mjs`;

      try {
        await writeFile(tmpFile, input.code, "utf-8");

        // Allowlist-only env
        const cleanEnv = {
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

        if (context?.databaseManager) {
          try {
            await context.databaseManager.logAgentActivity(
              context.dbConfig.dbType, context.dbConfig.db, context.dbConfig.connectionString,
              context.userID, {
                type: 'code_execution',
                code: input.code.slice(0, 500),
                output: (stdout || stderr || '').slice(0, 500),
                success: !stderr
              }
            );
          } catch (e) { /* best effort */ }
        }

        if (stderr) {
          return `Stderr:\n${stderr}\n\nStdout:\n${stdout}`;
        }

        return stdout || "(no output)";
      } catch (err) {
        await unlink(tmpFile).catch(() => {});

        if (context?.databaseManager) {
          try {
            await context.databaseManager.logAgentActivity(
              context.dbConfig.dbType, context.dbConfig.db, context.dbConfig.connectionString,
              context.userID, {
                type: 'code_execution',
                code: input.code.slice(0, 500),
                output: (err.stderr || err.message || '').slice(0, 500),
                success: false
              }
            );
          } catch (e) { /* best effort */ }
        }

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
];
