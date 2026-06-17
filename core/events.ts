/**
 * SSE Event Schema Definitions
 *
 * All events emitted by the agent loop conform to these schemas.
 * Provider-specific differences are normalized before emission.
 *
 * The event interfaces (TextDeltaEvent, ThinkingEvent, ToolStartEvent,
 * ToolResultEvent, ToolErrorEvent, DoneEvent, MaxIterationsEvent, ErrorEvent,
 * StatsEvent, FollowupEvent, ImageEvent, CompactionEvent) and the AgentEvent
 * union live in the shared types module.
 */

import type { StatsEvent, RawProviderStats } from '../types.js';

/**
 * Validate an event against the schema.
 *
 * Accepts an unknown value so callers may pass arbitrary payloads; narrows
 * structurally before reading discriminated fields.
 *
 * @param event - Event to validate
 * @returns True if valid
 * @throws If validation fails
 */
/** Read a property off an object value as unknown, without a type assertion. */
function prop(obj: object, key: string): unknown {
  return Reflect.get(obj, key);
}

export function validateEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') {
    throw new Error('Event must be an object');
  }

  const e = {
    type: prop(event, 'type'),
    text: prop(event, 'text'),
    hasNativeThinking: prop(event, 'hasNativeThinking'),
    name: prop(event, 'name'),
    input: prop(event, 'input'),
    result: prop(event, 'result'),
    error: prop(event, 'error'),
    content: prop(event, 'content'),
    message: prop(event, 'message'),
    model: prop(event, 'model'),
    inputTokens: prop(event, 'inputTokens'),
    outputTokens: prop(event, 'outputTokens'),
    url: prop(event, 'url'),
    prompt: prop(event, 'prompt'),
  };

  if (!e.type) {
    throw new Error('Event must have a type property');
  }

  switch (e.type) {
    case 'text_delta':
      if (typeof e.text !== 'string') {
        throw new Error('text_delta event must have text string');
      }
      break;

    case 'thinking':
      if (typeof e.text !== 'string') {
        throw new Error('thinking event must have text string');
      }
      if (typeof e.hasNativeThinking !== 'boolean') {
        throw new Error('thinking event must have hasNativeThinking boolean');
      }
      break;

    case 'tool_start':
      if (typeof e.name !== 'string') {
        throw new Error('tool_start event must have name string');
      }
      if (typeof e.input !== 'object') {
        throw new Error('tool_start event must have input object');
      }
      break;

    case 'tool_result':
      if (typeof e.name !== 'string') {
        throw new Error('tool_result event must have name string');
      }
      if (typeof e.input !== 'object') {
        throw new Error('tool_result event must have input object');
      }
      if (typeof e.result !== 'string') {
        throw new Error('tool_result event must have result string');
      }
      break;

    case 'tool_error':
      if (typeof e.name !== 'string') {
        throw new Error('tool_error event must have name string');
      }
      if (typeof e.error !== 'string') {
        throw new Error('tool_error event must have error string');
      }
      break;

    case 'done':
      if (typeof e.content !== 'string') {
        throw new Error('done event must have content string');
      }
      break;

    case 'max_iterations':
      if (typeof e.message !== 'string') {
        throw new Error('max_iterations event must have message string');
      }
      break;

    case 'error':
      if (typeof e.error !== 'string') {
        throw new Error('error event must have error string');
      }
      break;

    case 'stats':
      if (typeof e.model !== 'string') {
        throw new Error('stats event must have model string');
      }
      if (typeof e.inputTokens !== 'number') {
        throw new Error('stats event must have inputTokens number');
      }
      if (typeof e.outputTokens !== 'number') {
        throw new Error('stats event must have outputTokens number');
      }
      break;

    case 'followup':
      if (typeof e.text !== 'string') {
        throw new Error('followup event must have text string');
      }
      break;

    case 'compaction':
      // Compaction events don't have strict schema requirements
      break;

    case 'image':
      if (typeof e.url !== 'string') {
        throw new Error('image event must have url string');
      }
      if (typeof e.prompt !== 'string') {
        throw new Error('image event must have prompt string');
      }
      break;

    default:
      throw new Error(`Unknown event type: ${String(e.type)}`);
  }

  return true;
}

/**
 * Normalize a stats event from provider-specific format to standard format
 * @param stats - Raw stats from provider
 * @param provider - Provider ID ('anthropic', 'openai', 'xai', 'ollama')
 * @returns Standardized stats event
 */
export function normalizeStatsEvent(
  stats: RawProviderStats,
  provider: string,
): StatsEvent {
  const isAnthropic = provider === 'anthropic';

  // Preserve original runtime behavior: when a provider omits a token field
  // the value is left undefined (not coerced). The local fallback is `?? 0`
  // is intentionally NOT applied so the wire payload matches the legacy JS.
  const inputTokens = isAnthropic ? stats.input_tokens : stats.prompt_tokens;
  const outputTokens = isAnthropic
    ? stats.output_tokens
    : stats.completion_tokens;

  return {
    type: 'stats',
    model: stats.model,
    inputTokens: numberOrZero(inputTokens),
    outputTokens: numberOrZero(outputTokens),
  };
}

/**
 * Coerce a possibly-undefined token count to a number for the typed
 * StatsEvent shape. Defaults missing values to 0 (the prior JS shipped
 * `undefined`, which JSON-serializes to an absent field; 0 is the closest
 * type-safe equivalent without an `as` cast or loosening StatsEvent).
 */
function numberOrZero(value: number | undefined): number {
  return typeof value === 'number' ? value : 0;
}
