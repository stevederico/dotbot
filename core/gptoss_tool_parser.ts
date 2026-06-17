/**
 * Text-Based Tool Call Parser
 *
 * Parses tool calls from model output in four formats:
 *
 * 1. Instructed format (via system prompt):
 *    <tool_call>{"name": "tool_name", "arguments": {"key": "value"}}</tool_call>
 *
 * 2. Native gpt-oss format (from model fine-tuning):
 *    commentary to=tool_name json{"key": "value"}
 *
 * 3. LFM2.5 native format with markers:
 *    <|tool_call_start|>[tool_name(arg1="value1")]<|tool_call_end|>
 *
 * 4. LFM2.5 bare Pythonic format (markers stripped by local LLM server):
 *    [tool_name(arg1="value1", arg2="value2")]
 *
 * Used when the model doesn't support native OpenAI-style tool calling
 * (e.g., local LLM server) and tool definitions are injected via system prompt.
 */

import console from 'node:console';

import type { JsonObject, JsonValue } from '../types.js';

/**
 * A parsed text-format tool call, shaped to match what parseOpenAIStream
 * produces so the existing execution loop works unchanged. Note `arguments`
 * is a parsed object here (unlike the wire-format WireToolCall, whose
 * `arguments` is a JSON-encoded string).
 */
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

// Bare Pythonic: [func_name(key="val")] or [func_name(key='val')]
// Requires at least one key=quoted_value pair to avoid false positives on markdown links
const BARE_PYTHONIC_RE = /\[(\w+)\((\w+\s*=\s*(?:"[^"]*"|'[^']*')(?:\s*,\s*\w+\s*=\s*(?:"[^"]*"|'[^']*'|[\w.+-]+))*)\)\]/g;

/**
 * Detect if text contains tool call markers in any supported format.
 *
 * @param text - Model output text
 * @returns True if at least one tool call pattern is found
 */
export function hasToolCallMarkers(text: string): boolean {
  if (text.includes('<tool_call>') && text.includes('</tool_call>')) return true;
  if (/commentary\s+to=\w+\s+json\{/.test(text)) return true;
  if (text.includes('<|tool_call_start|>') && text.includes('<|tool_call_end|>')) return true;
  // Bare Pythonic: [word(word="...")]
  if (/\[\w+\(\w+\s*=\s*["']/.test(text)) return true;
  return false;
}

/**
 * Parse Pythonic keyword arguments from LFM tool call format.
 * Handles: key="value", key='value', key=123, key=true
 *
 * @param argsStr - Raw arguments string (e.g., 'location="New York", units="fahrenheit"')
 * @returns Parsed key-value pairs
 */
function parsePythonicArgs(argsStr: string): JsonObject {
  const args: JsonObject = {};
  if (!argsStr || !argsStr.trim()) return args;

  // Match key=value pairs where value can be quoted string, number, or boolean
  const argRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w.+-]+))/g;
  let m: RegExpExecArray | null;
  while ((m = argRe.exec(argsStr)) !== null) {
    const key = m[1];
    if (key === undefined) continue;
    // Prefer double-quoted, then single-quoted, then unquoted
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (val === undefined) continue;
    args[key] = val;
  }
  return args;
}

/**
 * Coerce a parsed-JSON arguments value into a JsonObject. The legacy JS
 * pushed whatever JSON.parse produced; downstream the loop treats it as an
 * object. Non-object results fall back to an empty object to match the
 * `|| {}` defaulting the original applied.
 */
function asJsonObject(value: JsonValue): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

/**
 * Extract all tool calls from text, returning them in the same shape
 * that parseOpenAIStream produces so the existing execution loop works unchanged.
 * Handles four formats: `<tool_call>` XML, gpt-oss `commentary to=`,
 * LFM `<|tool_call_start|>`, and bare Pythonic `[func(args)]`.
 *
 * @param text - Model output containing tool call patterns
 * @returns Parsed tool calls
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let idx = 0;

  // Format 1: <tool_call>{"name":"...","arguments":{...}}</tool_call>
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const raw = match[1] ?? '';
      const parsed = parseJson(raw.trim());
      const obj = asJsonObject(parsed);
      // `||` semantics preserved from the original JS (falsy → next).
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

  // Format 2: commentary to=TOOL_NAME json{...}  (gpt-oss native)
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

  // Format 3: <|tool_call_start|>[func_name(args)]<|tool_call_end|>  (LFM with markers)
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

  // Format 4: [func_name(key="val")]  (bare Pythonic, markers stripped by local LLM server)
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

/** Coerce a parsed name value to a string (legacy JS passed it through raw). */
function stringName(name: JsonValue | undefined): string {
  return typeof name === 'string' ? name : String(name);
}

/** Extract a message string from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a JSON string into a JsonValue. JSON.parse is typed `any`; constrain
 * its result to the explicit JsonValue union at the boundary.
 */
function parseJson(text: string): JsonValue {
  const parsed: JsonValue = JSON.parse(text);
  return parsed;
}

/**
 * Remove all tool call patterns from text (all four formats),
 * leaving only the surrounding natural language content.
 *
 * @param text - Model output containing tool call markers
 * @returns Text with all tool call blocks removed
 */
export function stripToolCallMarkers(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(TOOL_CALL_RE, '');
  cleaned = cleaned.replace(NATIVE_TOOL_CALL_RE, '');
  cleaned = cleaned.replace(LFM_TOOL_CALL_RE, '');
  cleaned = cleaned.replace(BARE_PYTHONIC_RE, '');
  return cleaned.trim();
}
