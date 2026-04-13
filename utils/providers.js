/**
 * AI provider registry for the agent library
 *
 * Provider configuration schema without environment variable coupling.
 * API keys and base URLs should be injected at runtime via createAgent().
 */

/**
 * Registry of supported AI providers.
 *
 * Each provider defines its API URL, default model, available models,
 * header construction, request/response formatting, and endpoint path.
 */
export const AI_PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    apiUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude Sonnet 3.7' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude Haiku 3.5' }
    ],
    headers: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2025-04-14',
      'Content-Type': 'application/json'
    }),
    endpoint: '/messages',
    formatRequest: (messages, model) => ({
      model,
      max_tokens: 4096,
      messages
    }),
    formatResponse: (data) => data.content?.[0]?.text
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    apiUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { id: 'gpt-4o', name: 'GPT-4o' }
    ],
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }),
    endpoint: '/chat/completions',
    formatRequest: (messages, model) => ({
      model,
      messages
    }),
    formatResponse: (data) => data.choices?.[0]?.message?.content
  },
  xai: {
    id: 'xai',
    name: 'xAI',
    envKey: 'XAI_API_KEY',
    apiUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4-1-fast-reasoning',
    models: [
      { id: 'grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning' },
      { id: 'grok-4-1-fast-non-reasoning', name: 'Grok 4.1 Fast' },
      { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
      { id: 'grok-4-fast-non-reasoning', name: 'Grok 4 Fast' },
      { id: 'grok-4-0709', name: 'Grok 4' },
      { id: 'grok-code-fast-1', name: 'Grok Code Fast' },
      { id: 'grok-3', name: 'Grok 3' },
      { id: 'grok-3-mini', name: 'Grok 3 Mini' },
      { id: 'grok-2-vision-1212', name: 'Grok 2 Vision' }
    ],
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }),
    endpoint: '/chat/completions',
    formatRequest: (messages, model) => ({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 4096
    }),
    formatResponse: (data) => data.choices?.[0]?.message?.content
  },
  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    apiUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'qwen-3-235b-a22b-instruct-2507',
    models: [
      { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
      { id: 'qwen-3-235b-a22b-instruct-2507', name: 'Qwen 3 235B' },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
      { id: 'zai-glm-4.7', name: 'ZAI GLM 4.7' },
    ],
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }),
    endpoint: '/chat/completions',
    formatRequest: (messages, model) => ({
      model,
      messages
    }),
    formatResponse: (data) => data.choices?.[0]?.message?.content
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    apiUrl: 'http://localhost:11434/v1',
    defaultModel: 'gpt-oss:20b',
    models: [],
    local: true,
    headers: () => ({
      'Content-Type': 'application/json'
    }),
    endpoint: '/chat/completions',
    formatRequest: (messages, model) => ({
      model,
      messages
    }),
    formatResponse: (data) => data.choices?.[0]?.message?.content
  },
  local: {
    // Local OpenAI-compatible server (e.g. local LLM server, LM Studio,
    // vLLM, llama.cpp server). Routes through the `local` branch in
    // core/agent.js which auto-detects gpt-oss channel tokens, native
    // reasoning, and plain-text responses. Override the URL with LOCAL_LLM_URL.
    id: 'local',
    name: 'Local',
    apiUrl: process.env.LOCAL_LLM_URL || 'http://127.0.0.1:1316/v1',
    defaultModel: '',
    models: [],
    local: true,
    headers: () => ({
      'Content-Type': 'application/json'
    }),
    endpoint: '/chat/completions',
    formatRequest: (messages, model) => ({
      model,
      messages
    }),
    formatResponse: (data) => data.choices?.[0]?.message?.content
  },
};
