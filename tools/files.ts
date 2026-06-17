/**
 * File system tools for user's virtual MongoDB filesystem
 */

import type {
  ToolDefinition,
  VirtualFile,
} from "../types.js";

export const fileTools: ToolDefinition[] = [
  // ── File Read ──
  {
    name: "file_read",
    description:
      "Read the contents of a file from the user's virtual filesystem. Use this when the user asks you to look at, review, or analyze a file they've saved.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Full file path, e.g. '/Documents/todo.md'",
        },
      },
      required: ["path"],
    },
    execute: async (input, signal, context): Promise<string> => {
      if (!context?.databaseManager) return "Error: filesystem not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID) return "Error: filesystem not available";
        const path = String(input.path);
        const file = await databaseManager.readFile(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID, path
        );
        if (!file) return `File not found: ${path}`;
        if (file.type === 'folder') return `${path} is a folder, not a file`;
        const content = file.content || '';
        const maxChars = 10000;
        if (content.length > maxChars) {
          return content.slice(0, maxChars) + `\n\n... [truncated, file is ${content.length} chars total]`;
        }
        return content || '(empty file)';
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── File Write ──
  {
    name: "file_write",
    description:
      "Write content to a file in the user's virtual filesystem. Creates the file if it doesn't exist, or updates it if it does. Use this when the user asks you to create or save a file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Full file path, e.g. '/Documents/todo.md'",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
    execute: async (input, signal, context): Promise<string> => {
      if (!context?.databaseManager) return "Error: filesystem not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID) return "Error: filesystem not available";
        const path = String(input.path);
        const inputContent = String(input.content);
        const existing = await databaseManager.readFile(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID, path
        );
        if (existing) {
          await databaseManager.updateFile(
            dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID, path, { content: inputContent }
          );
          return `Updated ${path} (${inputContent.length} chars)`;
        }
        const parts = path.split('/');
        const name = parts.pop() ?? '';
        const parentPath = parts.join('/') || '/';
        const ext = name.includes('.') ? (name.split('.').pop() ?? null) : null;
        await databaseManager.createFile(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
          { name, type: 'file', parentPath, content: inputContent, extension: ext, source: 'agent' }
        );
        return `Created ${path} (${inputContent.length} chars)`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── File List ──
  {
    name: "file_list",
    description: "List files and folders in a directory of the user's virtual filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list, e.g. '/' or '/Documents'. Default: '/'" },
      },
    },
    execute: async (input, signal, context): Promise<string> => {
      if (!context?.databaseManager) return "Error: filesystem not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID) return "Error: filesystem not available";
        const path = input.path ? String(input.path) : '/';
        await databaseManager.seedUserFiles(dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID);
        const files: VirtualFile[] = await databaseManager.listFiles(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID, path
        );
        if (!files || files.length === 0) return `No files in ${path}`;
        return files.map((f) =>
          `${f.type === 'folder' ? '📁' : '📄'} ${f.name}${f.extension ? '.' + f.extension : ''}${f.type === 'file' && f.size ? ' (' + f.size + ' bytes)' : ''}`
        ).join('\n');
      } catch (err) {
        return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── File Delete ──
  {
    name: "file_delete",
    description: "Delete a file or folder from the user's virtual filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full file path to delete, e.g. '/Documents/old.md'" },
      },
      required: ["path"],
    },
    execute: async (input, signal, context): Promise<string> => {
      if (!context?.databaseManager) return "Error: filesystem not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID) return "Error: filesystem not available";
        const path = String(input.path);
        const result = await databaseManager.deleteFiles(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID, path
        );
        return result.deletedCount > 0 ? `Deleted ${path}` : `File not found: ${path}`;
      } catch (err) {
        return `Error deleting file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── File Move/Rename ──
  {
    name: "file_move",
    description: "Move or rename a file in the user's virtual filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Current file path, e.g. '/Documents/old.md'" },
        new_name: { type: "string", description: "New file name (for rename)" },
        new_parent: { type: "string", description: "New parent path (for move), e.g. '/Downloads'" },
      },
      required: ["path"],
    },
    execute: async (input, signal, context): Promise<string> => {
      if (!context?.databaseManager) return "Error: filesystem not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID) return "Error: filesystem not available";
        const path = String(input.path);
        const newName = input.new_name ? String(input.new_name) : undefined;
        const newParent = input.new_parent ? String(input.new_parent) : undefined;
        const updates: Partial<VirtualFile> = {};
        if (newName) updates.name = newName;
        if (newParent) updates.parentPath = newParent;
        if (Object.keys(updates).length === 0) return "Provide new_name or new_parent to move/rename.";
        await databaseManager.updateFile(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID, path, updates
        );
        const dest = newParent
          ? `${newParent}/${newName || path.split('/').pop()}`
          : path.replace(/[^/]+$/, newName ?? '');
        return `Moved ${path} → ${dest}`;
      } catch (err) {
        return `Error moving file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Folder Create ──
  {
    name: "folder_create",
    description: "Create a new folder in the user's virtual filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Parent path, e.g. '/Documents'" },
        name: { type: "string", description: "Folder name to create" },
      },
      required: ["path", "name"],
    },
    execute: async (input, signal, context): Promise<string> => {
      if (!context?.databaseManager) return "Error: filesystem not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID) return "Error: filesystem not available";
        const path = String(input.path);
        const name = String(input.name);
        await databaseManager.createFile(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
          { name, type: 'folder', parentPath: path, source: 'agent' }
        );
        return `Created folder ${path}/${name}`;
      } catch (err) {
        return `Error creating folder: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
