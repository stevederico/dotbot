import { Outlet } from "react-router-dom";
import TabBar from "@stevederico/skateboard-ui/TabBar";
import { SidebarProvider, SidebarInset } from "@stevederico/skateboard-ui/shadcn/ui/sidebar";
import ChatSidebar from "./ChatSidebar.jsx";
import { getState } from "@stevederico/skateboard-ui/Context";

/**
 * Custom layout override that swaps the default Sidebar for ChatSidebar.
 *
 * Mirrors the default skateboard-ui Layout structure (SidebarProvider,
 * SidebarInset, TabBar, safe-area insets) but renders ChatSidebar
 * with the conversation history list instead of the static page links.
 *
 * @returns {JSX.Element} Layout with chat sidebar, main content, and tab bar
 */
export default function Layout() {
  const { state } = getState();
  const { sidebarVisible, tabBarVisible } = state.ui;
  const constants = state.constants;

  const showSidebar = !constants.hideSidebar && sidebarVisible;
  const showTabBar = !constants.hideTabBar && tabBarVisible;

  return (
    <div className="min-h-screen flex flex-col pt-[env(safe-area-inset-top)] pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <SidebarProvider
        defaultOpen={!constants.sidebarCollapsed}
        style={{
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "3.5rem",
        }}
      >
        {showSidebar && <ChatSidebar variant="inset" />}
        <SidebarInset
          className={`border border-border/50 ${
            constants.hideSidebarInsetRounding
              ? "md:peer-data-[variant=inset]:rounded-none"
              : ""
          }`}
        >
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
      {showTabBar && <TabBar className="md:hidden" />}
    </div>
  );
}
