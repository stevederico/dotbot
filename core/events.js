/**
 * SSE Event Schema Definitions
 *
 * All events emitted by the agent loop conform to these schemas.
 * Provider-specific differences are normalized before emission.
 */

/**
 * Text delta event - incremental text from the model
 * @typedef {Object} TextDeltaEvent
 * @property {'text_delta'} type
 * @property {string} text - Incremental text chunk
 */

/**
 * Thinking event - model's internal reasoning
 * @typedef {Object} ThinkingEvent
 * @property {'thinking'} type
 * @property {string} text - Reasoning text (empty string if no thinking available)
 * @property {boolean} hasNativeThinking - True if provider natively supports thinking
 */

/**
 * Tool start event - tool execution beginning
 * @typedef {Object} ToolStartEvent
 * @property {'tool_start'} type
 * @property {string} name - Tool name
 * @property {Object} input - Tool input parameters (already parsed)
 */

/**
 * Tool result event - tool execution completed successfully
 * @typedef {Object} ToolResultEvent
 * @property {'tool_result'} type
 * @property {string} name - Tool name
 * @property {Object} input - Tool input parameters
 * @property {string} result - Tool result (JSON string if object)
 */

/**
 * Tool error event - tool execution failed
 * @typedef {Object} ToolErrorEvent
 * @property {'tool_error'} type
 * @property {string} name - Tool name
 * @property {string} error - Error message
 */

/**
 * Done event - agent loop completed
 * @typedef {Object} DoneEvent
 * @property {'done'} type
 * @property {string} content - Final assistant response text
 */

/**
 * Max iterations event - loop exhausted iteration limit
 * @typedef {Object} MaxIterationsEvent
 * @property {'max_iterations'} type
 * @property {string} message - Warning message
 */

/**
 * Error event - fatal error occurred
 * @typedef {Object} ErrorEvent
 * @property {'error'} type
 * @property {string} error - Error message
 */

/**
 * Stats event - token usage statistics (standardized across providers)
 * @typedef {Object} StatsEvent
 * @property {'stats'} type
 * @property {string} model - Model name
 * @property {number} inputTokens - Input tokens consumed
 * @property {number} outputTokens - Output tokens generated
 */

/**
 * Followup event - suggested followup question
 * @typedef {Object} FollowupEvent
 * @property {'followup'} type
 * @property {string} text - Suggested followup text
 */

/**
 * Image event - generated image from tool
 * @typedef {Object} ImageEvent
 * @property {'image'} type
 * @property {string} url - Image URL
 * @property {string} prompt - Generation prompt
 */

/**
 * @typedef {TextDeltaEvent|ThinkingEvent|ToolStartEvent|ToolResultEvent|ToolErrorEvent|DoneEvent|MaxIterationsEvent|ErrorEvent|StatsEvent|FollowupEvent|ImageEvent} AgentEvent
 */

/**
 * Validate an event against the schema
 * @param {AgentEvent} event - Event to validate
 * @returns {boolean} True if valid
 * @throws {Error} If validation fails
 */
export function validateEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('Event must be an object');
  }

  if (!event.type) {
    throw new Error('Event must have a type property');
  }

  switch (event.type) {
    case 'text_delta':
      if (typeof event.text !== 'string') {
        throw new Error('text_delta event must have text string');
      }
      break;

    case 'thinking':
      if (typeof event.text !== 'string') {
        throw new Error('thinking event must have text string');
      }
      if (typeof event.hasNativeThinking !== 'boolean') {
        throw new Error('thinking event must have hasNativeThinking boolean');
      }
      break;

    case 'tool_start':
      if (typeof event.name !== 'string') {
        throw new Error('tool_start event must have name string');
      }
      if (typeof event.input !== 'object') {
        throw new Error('tool_start event must have input object');
      }
      break;

    case 'tool_result':
      if (typeof event.name !== 'string') {
        throw new Error('tool_result event must have name string');
      }
      if (typeof event.input !== 'object') {
        throw new Error('tool_result event must have input object');
      }
      if (typeof event.result !== 'string') {
        throw new Error('tool_result event must have result string');
      }
      break;

    case 'tool_error':
      if (typeof event.name !== 'string') {
        throw new Error('tool_error event must have name string');
      }
      if (typeof event.error !== 'string') {
        throw new Error('tool_error event must have error string');
      }
      break;

    case 'done':
      if (typeof event.content !== 'string') {
        throw new Error('done event must have content string');
      }
      break;

    case 'max_iterations':
      if (typeof event.message !== 'string') {
        throw new Error('max_iterations event must have message string');
      }
      break;

    case 'error':
      if (typeof event.error !== 'string') {
        throw new Error('error event must have error string');
      }
      break;

    case 'stats':
      if (typeof event.model !== 'string') {
        throw new Error('stats event must have model string');
      }
      if (typeof event.inputTokens !== 'number') {
        throw new Error('stats event must have inputTokens number');
      }
      if (typeof event.outputTokens !== 'number') {
        throw new Error('stats event must have outputTokens number');
      }
      break;

    case 'followup':
      if (typeof event.text !== 'string') {
        throw new Error('followup event must have text string');
      }
      break;

    case 'image':
      if (typeof event.url !== 'string') {
        throw new Error('image event must have url string');
      }
      if (typeof event.prompt !== 'string') {
        throw new Error('image event must have prompt string');
      }
      break;

    case 'compaction':
      // Compaction events don't have strict schema requirements
      break;

    default:
      throw new Error(`Unknown event type: ${event.type}`);
  }

  return true;
}

/**
 * Normalize a stats event from provider-specific format to standard format
 * @param {Object} stats - Raw stats from provider
 * @param {string} provider - Provider ID ('anthropic', 'openai', 'xai', 'ollama')
 * @returns {StatsEvent} Standardized stats event
 */
export function normalizeStatsEvent(stats, provider) {
  const isAnthropic = provider === 'anthropic';

  return {
    type: 'stats',
    model: stats.model,
    inputTokens: isAnthropic ? stats.input_tokens : stats.prompt_tokens,
    outputTokens: isAnthropic ? stats.output_tokens : stats.completion_tokens,
  };
}
