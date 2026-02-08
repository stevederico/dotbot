import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DynamicIcon from "@stevederico/skateboard-ui/DynamicIcon";
import { getState } from "@stevederico/skateboard-ui/Context";
import { apiRequest } from "@stevederico/skateboard-ui/Utilities";
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@stevederico/skateboard-ui/shadcn/ui/sidebar";
import { Button } from "@stevederico/skateboard-ui/shadcn/ui/button";
import { Settings } from "lucide-react";

/**
 * Custom sidebar showing conversation history list.
 *
 * Replaces the default skateboard-ui Sidebar with a ChatGPT-style
 * session list. Shows "New Chat" button, scrollable session items
 * with truncated titles, active highlighting, and hover-delete.
 * Refreshes via "sessions-updated" window event dispatched by ChatView.
 *
 * @param {Object} props
 * @param {string} [props.variant="inset"] - Sidebar variant passed to SidebarRoot
 * @returns {JSX.Element} Sidebar with conversation list
 */
export default function ChatSidebar({ variant = "inset", ...props }) {
  const { open } = useSidebar();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { state } = getState();
  const constants = state.constants;

  const [sessions, setSessions] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);

  const activeSessionId = searchParams.get("s");

  /** Fetch session list from backend */
  const fetchSessions = useCallback(async () => {
    if (!state.user) return;
    try {
      const data = await apiRequest("/agent/sessions");
      setSessions(data.sessions || []);
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    }
  }, [state.user]);

  // Fetch on mount and when user changes
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Listen for "sessions-updated" custom event from ChatView
  useEffect(() => {
    const handler = () => fetchSessions();
    window.addEventListener("sessions-updated", handler);
    return () => window.removeEventListener("sessions-updated", handler);
  }, [fetchSessions]);

  /**
   * Create a new chat session and navigate to it
   */
  const handleNewChat = async () => {
    try {
      const data = await apiRequest("/agent/sessions", { method: "POST" });
      if (data.id) {
        navigate(`/app/chat?s=${data.id}`);
        fetchSessions();
      }
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  };

  /**
   * Delete a session and navigate to the next available one
   *
   * @param {Event} e - Click event (stopped to prevent navigation)
   * @param {string} sessionId - Session UUID to delete
   */
  const handleDelete = async (e, sessionId) => {
    e.stopPropagation();
    try {
      await apiRequest(`/agent/sessions/${sessionId}`, { method: "DELETE" });
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);

      // If we deleted the active session, navigate to the next one
      if (activeSessionId === sessionId) {
        if (remaining.length > 0) {
          navigate(`/app/chat?s=${remaining[0].id}`);
        } else {
          // Create a fresh session
          handleNewChat();
        }
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  /**
   * Format a session title for display
   *
   * @param {Object} session - Session summary object
   * @returns {string} Truncated title or placeholder
   */
  const getDisplayTitle = (session) => {
    if (session.title) {
      return session.title.length > 40
        ? session.title.slice(0, 40) + "..."
        : session.title;
    }
    return "New conversation";
  };

  return (
    <SidebarRoot collapsible="icon" variant={variant} {...props}>
      {/* Header: App icon + name */}
      <SidebarHeader className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              onClick={() => navigate("/app")}
              tooltip={constants.appName}
              className="hover:bg-transparent active:bg-transparent"
            >
              <div className="bg-app flex items-center justify-center shrink-0 rounded-lg size-8 -ml-2">
                <DynamicIcon
                  name={constants.appIcon}
                  strokeWidth={2}
                  className="text-white"
                />
              </div>
              <span className="font-semibold text-lg shrink min-w-0 truncate">
                {constants.appName}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* New Chat button + session list */}
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {/* New Chat button */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  tooltip="New Chat"
                  onClick={handleNewChat}
                  className="font-medium"
                >
                  <DynamicIcon name="plus" size={20} strokeWidth={2} />
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Session list */}
              {sessions.map((session) => {
                const isActive = activeSessionId === session.id;
                return (
                  <SidebarMenuItem
                    key={session.id}
                    onMouseEnter={() => setHoveredId(session.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={session.title || "New conversation"}
                      size="sm"
                      className="data-active:font-normal group relative"
                      onClick={() => navigate(`/app/chat?s=${session.id}`)}
                    >
                      <DynamicIcon name="message-circle" size={20} strokeWidth={2} />
                      <span className="truncate flex-1">{getDisplayTitle(session)}</span>
                      {hoveredId === session.id && open && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => handleDelete(e, session.id)}
                          onKeyDown={(e) => e.key === "Enter" && handleDelete(e, session.id)}
                          className="absolute right-1 p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                        >
                          <DynamicIcon name="x" size={14} strokeWidth={2} />
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer: Settings */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={location.pathname.toLowerCase().includes("settings")}
              tooltip="Settings"
              size="sm"
              className="data-active:font-normal"
              onClick={() => navigate("/app/settings")}
            >
              <Settings size={20} strokeWidth={2} />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </SidebarRoot>
  );
}
