
import console from 'node:console';

import type { JsonObject, JsonValue } from '../types.js';

export interface ParsedToolCall {
  id: string;
  function: {
    name: string;
    arguments: JsonObject;
  };
}

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const NATIVE_TOOL_CALL_RE = /commentary\s+to=(\w+)\s+json(\{[\s\S]*?\})(?:\s|$)/g;
const LFM_TOOL_CALL_RE = /<\|tool_call_start\|>\[(\w+)\(([\s\S]*?)\)\]<\|tool_call_end\|>/g;

const BARE_PYTHONIC_RE = /\[(\w+)\((\w+\s*=\s*(?:"[^"]*"|'[^']*')(?:\s*,\s*\w+\s*=\s*(?:"[^"]*"|'[^']*'|[\w.+-]+))*)\)\]/g;

export function hasToolCallMarkers(text: string): boolean {
  if (text.includes('<tool_call>') && text.includes('</tool_call>')) return true;
  if (/commentary\s+to=\w+\s+json\{/.test(text)) return true;
  if (text.includes('<|tool_call_start|>') && text.includes('<|tool_call_end|>')) return true;
  if (/\[\w+\(\w+\s*=\s*["']/.test(text)) return true;
  return false;
}

function parsePythonicArgs(argsStr: string): JsonObject {
  const args: JsonObject = {};
  if (!argsStr || !argsStr.trim()) return args;

  const argRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w.+-]+))/g;
  let m: RegExpExecArray | null;
  while ((m = argRe.exec(argsStr)) !== null) {
    const key = m[1];
    if (key === undefined) continue;
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (val === undefined) continue;
    args[key] = val;
  }
  return args;
}

function asJsonObject(value: JsonValue): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let idx = 0;

  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const raw = match[1] ?? '';
      const parsed = parseJson(raw.trim());
      const obj = asJsonObject(parsed);
      const name: JsonValue | undefined = obj.name || obj.function;
      let args: JsonValue = obj.arguments || obj.params || obj.input || {};
      if (typeof args === 'string') {
        try { args = parseJson(args); } catch {}
      }
      calls.push({
        id: `text_call_${idx}`,
        function: { name: stringName(name), arguments: asJsonObject(args) },
      });
      idx++;
    } catch (err) {
      console.warn('[tool_parser] Failed to parse <tool_call> JSON:', match[1], errMessage(err));
    }
  }

  if (calls.length === 0) {
    NATIVE_TOOL_CALL_RE.lastIndex = 0;
    while ((match = NATIVE_TOOL_CALL_RE.exec(text)) !== null) {
      try {
        const name = match[1] ?? '';
        const args = parseJson(match[2] ?? '');
        calls.push({
          id: `native_call_${idx}`,
          function: { name, arguments: asJsonObject(args) },
        });
        idx++;
      } catch (err) {
        console.warn('[tool_parser] Failed to parse native tool call:', match[0], errMessage(err));
      }
    }
  }

  if (calls.length === 0) {
    LFM_TOOL_CALL_RE.lastIndex = 0;
    while ((match = LFM_TOOL_CALL_RE.exec(text)) !== null) {
      try {
        const name = match[1] ?? '';
        const args = parsePythonicArgs(match[2] ?? '');
        calls.push({
          id: `lfm_call_${idx}`,
          function: { name, arguments: args },
        });
        idx++;
      } catch (err) {
        console.warn('[tool_parser] Failed to parse LFM tool call:', match[0], errMessage(err));
      }
    }
  }

  if (calls.length === 0) {
    BARE_PYTHONIC_RE.lastIndex = 0;
    while ((match = BARE_PYTHONIC_RE.exec(text)) !== null) {
      try {
        const name = match[1] ?? '';
        const args = parsePythonicArgs(match[2] ?? '');
        calls.push({
          id: `lfm_call_${idx}`,
          function: { name, arguments: args },
        });
        idx++;
      } catch (err) {
        console.warn('[tool_parser] Failed to parse bare Pythonic tool call:', match[0], errMessage(err));
      }
    }
  }

  return calls;
}

function stringName(name: JsonValue | undefined): string {
  return typeof name === 'string' ? name : String(name);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseJson(text: string): JsonValue {
  const parsed: JsonValue = JSON.parse(text);
  return parsed;
}

export function stripToolCallMarkers(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(TOOL_CALL_RE, '');
  cleaned = cleaned.replace(NATIVE_TOOL_CALL_RE, '');
  cleaned = cleaned.replace(LFM_TOOL_CALL_RE, '');
  cleaned = cleaned.replace(BARE_PYTHONIC_RE, '');
  return cleaned.trim();
}
