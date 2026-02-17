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
 * 4. LFM2.5 bare Pythonic format (markers stripped by mlx_lm.server):
 *    [tool_name(arg1="value1", arg2="value2")]
 *
 * Used when the model doesn't support native OpenAI-style tool calling
 * (e.g., mlx_lm.server) and tool definitions are injected via system prompt.
 */

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const NATIVE_TOOL_CALL_RE = /commentary\s+to=(\w+)\s+json(\{[\s\S]*?\})(?:\s|$)/g;
const LFM_TOOL_CALL_RE = /<\|tool_call_start\|>\[(\w+)\(([\s\S]*?)\)\]<\|tool_call_end\|>/g;

// Bare Pythonic: [func_name(key="val")] or [func_name(key='val')]
// Requires at least one key=quoted_value pair to avoid false positives on markdown links
const BARE_PYTHONIC_RE = /\[(\w+)\((\w+\s*=\s*(?:"[^"]*"|'[^']*')(?:\s*,\s*\w+\s*=\s*(?:"[^"]*"|'[^']*'|[\w.+-]+))*)\)\]/g;

/**
 * Detect if text contains tool call markers in any supported format.
 *
 * @param {string} text - Model output text
 * @returns {boolean} True if at least one tool call pattern is found
 */
export function hasToolCallMarkers(text) {
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
 * @param {string} argsStr - Raw arguments string (e.g., 'location="New York", units="fahrenheit"')
 * @returns {Object} Parsed key-value pairs
 */
function parsePythonicArgs(argsStr) {
  const args = {};
  if (!argsStr || !argsStr.trim()) return args;

  // Match key=value pairs where value can be quoted string, number, or boolean
  const argRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w.+-]+))/g;
  let m;
  while ((m = argRe.exec(argsStr)) !== null) {
    const key = m[1];
    // Prefer double-quoted, then single-quoted, then unquoted
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    args[key] = val;
  }
  return args;
}

/**
 * Extract all tool calls from text, returning them in the same shape
 * that parseOpenAIStream produces so the existing execution loop works unchanged.
 * Handles four formats: `<tool_call>` XML, gpt-oss `commentary to=`,
 * LFM `<|tool_call_start|>`, and bare Pythonic `[func(args)]`.
 *
 * @param {string} text - Model output containing tool call patterns
 * @returns {Array<{id: string, function: {name: string, arguments: Object}}>}
 */
export function parseToolCalls(text) {
  const calls = [];
  let idx = 0;

  // Format 1: <tool_call>{"name":"...","arguments":{...}}</tool_call>
  TOOL_CALL_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const name = parsed.name || parsed.function;
      let args = parsed.arguments || parsed.params || parsed.input || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }
      calls.push({
        id: `text_call_${idx}`,
        function: { name, arguments: args },
      });
      idx++;
    } catch (err) {
      console.warn('[tool_parser] Failed to parse <tool_call> JSON:', match[1], err.message);
    }
  }

  // Format 2: commentary to=TOOL_NAME json{...}  (gpt-oss native)
  if (calls.length === 0) {
    NATIVE_TOOL_CALL_RE.lastIndex = 0;
    while ((match = NATIVE_TOOL_CALL_RE.exec(text)) !== null) {
      try {
        const name = match[1];
        const args = JSON.parse(match[2]);
        calls.push({
          id: `native_call_${idx}`,
          function: { name, arguments: args },
        });
        idx++;
      } catch (err) {
        console.warn('[tool_parser] Failed to parse native tool call:', match[0], err.message);
      }
    }
  }

  // Format 3: <|tool_call_start|>[func_name(args)]<|tool_call_end|>  (LFM with markers)
  if (calls.length === 0) {
    LFM_TOOL_CALL_RE.lastIndex = 0;
    while ((match = LFM_TOOL_CALL_RE.exec(text)) !== null) {
      try {
        const name = match[1];
        const args = parsePythonicArgs(match[2]);
        calls.push({
          id: `lfm_call_${idx}`,
          function: { name, arguments: args },
        });
        idx++;
      } catch (err) {
        console.warn('[tool_parser] Failed to parse LFM tool call:', match[0], err.message);
      }
    }
  }

  // Format 4: [func_name(key="val")]  (bare Pythonic, markers stripped by mlx_lm.server)
  if (calls.length === 0) {
    BARE_PYTHONIC_RE.lastIndex = 0;
    while ((match = BARE_PYTHONIC_RE.exec(text)) !== null) {
      try {
        const name = match[1];
        const args = parsePythonicArgs(match[2]);
        calls.push({
          id: `lfm_call_${idx}`,
          function: { name, arguments: args },
        });
        idx++;
      } catch (err) {
        console.warn('[tool_parser] Failed to parse bare Pythonic tool call:', match[0], err.message);
      }
    }
  }

  return calls;
}

/**
 * Remove all tool call patterns from text (all four formats),
 * leaving only the surrounding natural language content.
 *
 * @param {string} text - Model output containing tool call markers
 * @returns {string} Text with all tool call blocks removed
 */
export function stripToolCallMarkers(text) {
  let cleaned = text;
  cleaned = cleaned.replace(TOOL_CALL_RE, '');
  cleaned = cleaned.replace(NATIVE_TOOL_CALL_RE, '');
  cleaned = cleaned.replace(LFM_TOOL_CALL_RE, '');
  cleaned = cleaned.replace(BARE_PYTHONIC_RE, '');
  return cleaned.trim();
}
