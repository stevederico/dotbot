import Header from '@stevederico/skateboard-ui/Header';
import DynamicIcon from '@stevederico/skateboard-ui/DynamicIcon';
import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import Markdown from "react-markdown";
import { getBackendURL, getCSRFToken, apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { getState } from '@stevederico/skateboard-ui/Context';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Card, CardContent } from '@stevederico/skateboard-ui/shadcn/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@stevederico/skateboard-ui/shadcn/ui/select';

/**
 * Chat view with SSE streaming to DotBot agent backend.
 *
 * Reads sessionId from the `?s=` URL search param. On mount:
 * - If no `?s=` param: fetches session list, navigates to most recent or creates new
 * - If `?s=` present: loads history for that session
 *
 * Dispatches `window` "sessions-updated" event after sends so ChatSidebar refreshes.
 *
 * @component
 * @returns {JSX.Element} Chat view with agent interface
 */
export default function ChatView() {
  const { state, dispatch } = getState();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("s");

  const requireAuth = useCallback((callback) => {
    if (state.user) {
      callback();
    } else {
      dispatch({ type: 'SHOW_AUTH_OVERLAY', payload: callback });
    }
  }, [state.user, dispatch]);

  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [ollamaStatus, setOllamaStatus] = useState({ running: false, models: [], currentModel: "" });
  const [selectedModel, setSelectedModel] = useState("");

  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isStreaming]);

  // Resolve session on mount — if no ?s= param, fetch sessions and navigate
  useEffect(() => {
    if (!state.user) {
      setIsLoading(false);
      return;
    }
    if (sessionId) return; // Already have a session, handled below

    const resolveSession = async () => {
      try {
        const data = await apiRequest("/agent/sessions");
        if (data.sessions?.length > 0) {
          navigate(`/app/chat?s=${data.sessions[0].id}`, { replace: true });
        } else {
          // No sessions — create one
          const newSession = await apiRequest("/agent/sessions", { method: "POST" });
          navigate(`/app/chat?s=${newSession.id}`, { replace: true });
        }
      } catch (err) {
        console.error("Failed to resolve session:", err);
        setIsLoading(false);
      }
    };
    resolveSession();
  }, [state.user, sessionId, navigate]);

  // Fetch status and history when sessionId changes
  useEffect(() => {
    if (!state.user || !sessionId) return;

    setIsLoading(true);
    setMessages([]);

    const fetchStatus = async () => {
      try {
        const data = await apiRequest(`/agent/status?sessionId=${sessionId}`);
        setOllamaStatus(data);
        if (data.currentModel) setSelectedModel(data.currentModel);
      } catch (err) {
        console.error("Failed to fetch agent status:", err);
      }
    };

    const fetchHistory = async () => {
      try {
        const data = await apiRequest(`/agent/history?sessionId=${sessionId}`);
        if (data.messages?.length) {
          setMessages(data.messages.map((m) => ({
            id: crypto.randomUUID(),
            role: m.role,
            content: m.content,
          })));
        }
      } catch (err) {
        console.error("Failed to fetch chat history:", err);
      }
    };

    Promise.all([fetchStatus(), fetchHistory()]).finally(() => setIsLoading(false));
  }, [state.user, sessionId]);

  /**
   * Handle model change from the picker
   *
   * @param {string} model - Ollama model name to switch to
   */
  const handleModelChange = async (model) => {
    setSelectedModel(model);
    try {
      await apiRequest("/agent/model", {
        method: "POST",
        body: JSON.stringify({ model, sessionId }),
      });
    } catch (err) {
      console.error("Failed to set model:", err);
    }
  };

  /**
   * Clear the conversation history for the current session
   */
  const handleClear = async () => {
    if (!sessionId) return;
    try {
      await apiRequest("/agent/clear", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      });
      setMessages([]);
    } catch (err) {
      console.error("Failed to clear chat:", err);
    }
  };

  /**
   * Stop the current streaming response
   */
  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsStreaming(false);
    }
  };

  /**
   * Send a message and stream the agent response via SSE.
   *
   * Passes sessionId in the POST body. Dispatches "sessions-updated"
   * event after a successful send so the sidebar refreshes titles.
   *
   * @async
   */
  const handleSend = async () => {
    if (isLoading || isStreaming) return;
    if (!newMessage.trim()) return;

    const userMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: newMessage.trim(),
    };

    setMessages(prev => [...prev, userMsg]);
    setNewMessage("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev, {
      id: assistantId,
      role: "assistant",
      content: "",
      toolCalls: [],
    }]);

    try {
      const csrfToken = getCSRFToken();
      const res = await fetch(`${getBackendURL()}/agent/chat`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken && { "X-CSRF-Token": csrfToken }),
        },
        body: JSON.stringify({ message: userMsg.content, sessionId }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server error ${res.status}`);
      }

      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);
              handleSSEEvent(event, assistantId);
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      // Notify sidebar to refresh (title may have been set from first message)
      window.dispatchEvent(new Event("sessions-updated"));
    } catch (err) {
      if (err.name === "AbortError") {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: m.content + "\n\n*[Stopped]*" }
            : m
        ));
      } else {
        console.error("Chat error:", err);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `Error: ${err.message}`, isError: true }
            : m
        ));
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  /**
   * Handle an individual SSE event from the agent stream
   *
   * @param {Object} event - Parsed SSE event object
   * @param {string} assistantId - ID of the assistant message to update
   */
  const handleSSEEvent = (event, assistantId) => {
    switch (event.type) {
      case "text_delta":
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: m.content + event.text }
            : m
        ));
        break;

      case "tool_start":
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? {
              ...m,
              toolCalls: [...(m.toolCalls || []), {
                name: event.name,
                input: event.input,
                status: "running",
              }],
            }
            : m
        ));
        break;

      case "tool_result":
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? {
              ...m,
              toolCalls: (m.toolCalls || []).map(tc =>
                tc.name === event.name && tc.status === "running"
                  ? { ...tc, status: "done", result: event.result }
                  : tc
              ),
            }
            : m
        ));
        break;

      case "tool_error":
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? {
              ...m,
              toolCalls: (m.toolCalls || []).map(tc =>
                tc.name === event.name && tc.status === "running"
                  ? { ...tc, status: "error", result: event.error }
                  : tc
              ),
            }
            : m
        ));
        break;

      case "error":
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: m.content + `\n\nError: ${event.error}`, isError: true }
            : m
        ));
        break;

      // "done" and "stats" are informational — no UI update needed
    }
  };

  return (
    <div className="flex flex-col flex-1 h-full">
      <Header title="Chat" />

      {/* Toolbar: model picker, status, clear */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
        <div className={`w-2 h-2 rounded-full ${ollamaStatus.running ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-xs text-muted-foreground">
          {ollamaStatus.running ? 'Ollama' : 'Offline'}
        </span>

        {ollamaStatus.models.length > 0 && (
          <Select value={selectedModel} onValueChange={handleModelChange}>
            <SelectTrigger className="w-40 h-7 text-xs">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              {ollamaStatus.models.map(m => (
                <SelectItem key={m.name} value={m.name} className="text-xs">
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="flex-1" />

        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleClear} className="h-7 text-xs text-muted-foreground">
            <DynamicIcon name="trash-2" size={14} className="mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <DynamicIcon name="message-circle" size={48} className="mb-4 opacity-30" />
            <p className="text-sm">Send a message to start chatting</p>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'user' ? (
              <div className="max-w-2xl">
                <Card className="py-0 gap-0 shadow-none ring-0 bg-accent rounded-br-sm">
                  <CardContent className="px-4 py-2.5">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  </CardContent>
                </Card>
              </div>
            ) : (
              <div className="w-full flex flex-col">
                {msg.toolCalls?.length > 0 && (
                  <div className="space-y-1 mb-2">
                    {msg.toolCalls.map((tc, i) => (
                      <ToolCallBadge key={`${tc.name}-${i}`} toolCall={tc} />
                    ))}
                  </div>
                )}
                {msg.content && (
                  <div className={`text-sm leading-relaxed [&_p]:mb-3 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_em]:italic [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_li]:mb-1 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-bold [&_h2]:mb-2 [&_h3]:font-bold [&_h3]:mb-1 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:my-2 [&_a]:text-app [&_a]:underline [&_hr]:my-3 [&_hr]:border-muted ${msg.isError ? 'text-destructive' : ''}`}>
                    <Markdown>{msg.content}</Markdown>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {isStreaming && messages[messages.length - 1]?.content === "" && !messages[messages.length - 1]?.toolCalls?.length && (
          <div className="flex space-x-1.5 py-1">
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"></div>
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0.15s' }}></div>
            <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="p-4 pb-20 md:pb-4 bg-background rounded-b-xl">
        <div className="flex gap-2">
          <Input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && requireAuth(() => handleSend())}
            placeholder="Message..."
            disabled={isStreaming || !ollamaStatus.running}
            className="flex-1 h-10 rounded-full bg-accent border-0 px-4 focus-visible:ring-app"
          />
          {isStreaming ? (
            <Button
              size="icon"
              onClick={handleStop}
              className="rounded-full w-10 h-10 bg-destructive text-white hover:bg-destructive/80"
            >
              <DynamicIcon name="square" size={16} />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={() => requireAuth(() => handleSend())}
              disabled={isLoading || !ollamaStatus.running}
              className={`rounded-full w-10 h-10 ${
                newMessage.trim() && !isLoading && ollamaStatus.running
                  ? 'bg-app text-white hover:bg-app/80'
                  : 'bg-accent text-foreground opacity-50'
              }`}
            >
              <DynamicIcon name="arrow-up" size={18} />
            </Button>
          )}
        </div>
      </div>

    </div>
  );
}

/**
 * Format tool input into a short inline summary string.
 *
 * Extracts the most relevant parameter (e.g. query, url, path, name)
 * and truncates it for display next to the tool name badge.
 *
 * @param {Object} input - Tool call input parameters
 * @returns {string} Short summary string or empty string
 */
function formatToolInputSummary(input) {
  if (!input || typeof input !== "object") return "";
  const key = input.query || input.url || input.path || input.name || input.content;
  if (!key) return "";
  const str = String(key);
  return str.length > 40 ? str.slice(0, 40) + "..." : str;
}

/**
 * Inline tool call display badge
 *
 * Shows tool name with running/done/error status indicator.
 * Displays a short input summary inline (e.g. query, url, path).
 * Expandable on click to show full input parameters and result.
 *
 * @param {Object} props
 * @param {Object} props.toolCall - Tool call object with name, input, status, result
 * @returns {JSX.Element} Tool call badge with expandable details
 */
function ToolCallBadge({ toolCall }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const statusIcon = {
    running: "loader-2",
    done: "check",
    error: "x",
  }[toolCall.status];

  const statusColor = {
    running: "bg-blue-500/10 text-blue-600 border-blue-200",
    done: "bg-green-500/10 text-green-600 border-green-200",
    error: "bg-red-500/10 text-red-600 border-red-200",
  }[toolCall.status];

  const summary = formatToolInputSummary(toolCall.input);

  return (
    <div>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs border ${statusColor} cursor-pointer hover:opacity-80 transition-opacity`}
      >
        <DynamicIcon
          name={statusIcon}
          size={12}
          className={toolCall.status === 'running' ? 'animate-spin' : ''}
        />
        {toolCall.name.replace(/_/g, " ")}
        {summary && (
          <span className="opacity-60 ml-0.5 truncate max-w-48">{summary}</span>
        )}
      </button>
      {isExpanded && (
        <div className="mt-1 space-y-1">
          {toolCall.input && Object.keys(toolCall.input).length > 0 && (
            <pre className="p-2 bg-muted rounded text-xs overflow-x-auto max-h-24 whitespace-pre-wrap text-muted-foreground">
              {Object.entries(toolCall.input).map(([k, v]) =>
                `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
              ).join("\n")}
            </pre>
          )}
          {toolCall.result && (
            <pre className="p-2 bg-muted rounded text-xs overflow-x-auto max-h-32 whitespace-pre-wrap">
              {toolCall.result.slice(0, 500)}
              {toolCall.result.length > 500 ? "..." : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
