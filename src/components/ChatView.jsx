import Header from '@stevederico/skateboard-ui/Header';
import UpgradeSheet from '@stevederico/skateboard-ui/UpgradeSheet';
import DynamicIcon from '@stevederico/skateboard-ui/DynamicIcon';
import { useState, useEffect, useRef, useCallback } from "react";
import { getRemainingUsage, trackUsage, showUpgradeSheet, getBackendURL, getCSRFToken, apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { getState } from '@stevederico/skateboard-ui/Context';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Card, CardContent } from '@stevederico/skateboard-ui/shadcn/ui/card';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@stevederico/skateboard-ui/shadcn/ui/select';

/**
 * Chat view with SSE streaming to DotBot agent backend
 *
 * Features:
 * - SSE streaming via fetch + ReadableStream (POST not supported by EventSource)
 * - Model picker populated from Ollama /api/agent/status
 * - Tool call display inline (running/done/error states)
 * - Stop button during streaming (AbortController)
 * - Clear chat button
 * - Usage tracking per message for non-subscribers
 * - Auto-scroll to latest message
 *
 * @component
 * @returns {JSX.Element} Chat view with agent interface
 */
export default function ChatView() {
  const { state, dispatch } = getState();
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
  const [usageInfo, setUsageInfo] = useState({ remaining: -1, isSubscriber: true });
  const [isLoading, setIsLoading] = useState(true);
  const [ollamaStatus, setOllamaStatus] = useState({ running: false, models: [], currentModel: "" });
  const [selectedModel, setSelectedModel] = useState("");

  const isUserSubscriber = usageInfo.isSubscriber;
  const upgradeSheetRef = useRef();
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isStreaming]);

  // Fetch Ollama status and models on mount
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const data = await apiRequest("/agent/status");
        setOllamaStatus(data);
        if (data.currentModel) setSelectedModel(data.currentModel);
      } catch (err) {
        console.error("Failed to fetch agent status:", err);
      }
    };

    const updateUsage = async () => {
      try {
        const usage = await getRemainingUsage('messages');
        setUsageInfo(usage);
      } catch (error) {
        console.error('Error updating usage:', error);
      } finally {
        setIsLoading(false);
      }
    };

    if (state.user) {
      fetchStatus();
      updateUsage();
    } else {
      setIsLoading(false);
    }
  }, [state.user]);

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
        body: JSON.stringify({ model }),
      });
    } catch (err) {
      console.error("Failed to set model:", err);
    }
  };

  /**
   * Clear the conversation history
   */
  const handleClear = async () => {
    try {
      await apiRequest("/agent/clear", { method: "POST" });
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
   * Send a message and stream the agent response via SSE
   *
   * Uses fetch + ReadableStream to parse SSE events from POST endpoint.
   * Tracks usage for non-subscribers. Displays tool calls inline.
   *
   * @async
   */
  const handleSend = async () => {
    if (isLoading || isStreaming) return;
    if (!newMessage.trim()) return;

    if (!usageInfo.isSubscriber && usageInfo.remaining <= 0) {
      showUpgradeSheet(upgradeSheetRef);
      return;
    }

    const userMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: newMessage.trim(),
    };

    setMessages(prev => [...prev, userMsg]);
    setNewMessage("");
    setIsStreaming(true);

    // Track usage
    const updatedUsage = await trackUsage('messages');
    setUsageInfo(updatedUsage);

    // Create abort controller for stop button
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Placeholder for assistant response
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
        body: JSON.stringify({ message: userMsg.content }),
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
    } catch (err) {
      if (err.name === "AbortError") {
        // User stopped — just mark as done
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
      <Header
        title="Chat"
        buttonTitle={!isUserSubscriber && usageInfo.remaining >= 0 ? `${usageInfo.remaining}` : undefined}
        buttonClass={!isUserSubscriber && usageInfo.remaining >= 0 ? "rounded-full w-10 h-10 flex items-center justify-center text-lg" : ""}
        onButtonTitleClick={!isUserSubscriber ? () => showUpgradeSheet(upgradeSheetRef) : undefined}
      />

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
            <div className={`max-w-2xl ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
              {/* Tool calls (shown above assistant text) */}
              {msg.toolCalls?.length > 0 && (
                <div className="space-y-1 mb-2">
                  {msg.toolCalls.map((tc, i) => (
                    <ToolCallBadge key={`${tc.name}-${i}`} toolCall={tc} />
                  ))}
                </div>
              )}

              <Card className={`py-0 gap-0 shadow-none ring-0 ${
                msg.role === 'user'
                  ? 'bg-app text-white rounded-br-sm'
                  : msg.isError
                    ? 'bg-destructive/10 border-destructive/20 rounded-bl-sm'
                    : 'bg-accent rounded-bl-sm'
              }`}>
                <CardContent className="px-4 py-2.5">
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                </CardContent>
              </Card>
            </div>
          </div>
        ))}

        {isStreaming && messages[messages.length - 1]?.content === "" && (
          <div className="flex justify-start">
            <Card className="py-0 gap-0 shadow-none ring-0 bg-accent rounded-bl-sm">
              <CardContent className="px-4 py-2.5">
                <div className="flex space-x-1.5">
                  <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"></div>
                  <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0.15s' }}></div>
                  <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="p-4 pb-20 md:pb-4 border-t bg-background">
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

      <UpgradeSheet
        ref={upgradeSheetRef}
        userEmail={state.user?.email}
      />
    </div>
  );
}

/**
 * Inline tool call display badge
 *
 * Shows tool name with running/done/error status indicator.
 * Expandable to show result on click.
 *
 * @param {Object} props
 * @param {Object} props.toolCall - Tool call object with name, status, result
 * @returns {JSX.Element} Tool call badge
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
      </button>
      {isExpanded && toolCall.result && (
        <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto max-h-32 whitespace-pre-wrap">
          {toolCall.result.slice(0, 500)}
          {toolCall.result.length > 500 ? "..." : ""}
        </pre>
      )}
    </div>
  );
}
