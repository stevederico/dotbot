Core AI Agent Framework Features (Both Have)                                                                                      
                                                                                                                                    
  1. Multi-Provider AI Support - Anthropic, OpenAI, multiple LLM backends                                                           
  2. Long-Term Memory - Persistent storage across sessions
  3. Tool Execution System - Agent can perform actions (web search, file ops, etc.)                                                 
  4. Session Management - Track conversation history
  5. Scheduled Tasks - Cron/recurring actions
  6. Web Search Integration - Access current information
  7. File Operations - Read/write/manage files
  8. Context Preservation - Maintain state between turns

  The "Must-Have" List

  Every AI agent framework needs:

  - ✅ LLM Integration (API to Claude/GPT/etc.)
  - ✅ Memory/Storage (remember past conversations)
  - ✅ Tool System (execute actions beyond chat)
  - ✅ Session Tracking (multi-turn conversations)
  - ✅ Scheduling (delayed/recurring tasks)

  Optional but common:
  - Web search
  - File management
  - Multi-user support
  - Event triggers
Standard AI Agent Tools (Industry Common)                                                                                         
                                                    
  Core Tier (Nearly Universal)                                                                                                      
                                                                                                                                    
  1. Memory/Storage - Save, search, retrieve information                                                                            
  2. Web Search - Current information lookup                                                                                        
  3. Web Fetch - HTTP requests to APIs/URLs                                                                                         
  4. File Operations - Read, write, list, delete files
  5. Code Execution - Run code snippets (Python/JS/etc.)

  Common Tier (Most Frameworks)

  6. Calculator/Math - Precise calculations
  7. Time/Date - Current time, scheduling
  8. Command Execution - Shell commands (sandboxed)
  9. Database Queries - Read/write to databases

  Extended Tier (Advanced Frameworks)

  10. Browser Automation - Navigate, click, screenshot
  11. Image Generation - Create images from prompts
  12. Image Analysis - Describe/analyze images
  13. Email - Send/read emails
  14. Notifications - Push alerts to users
  15. Weather - Current conditions/forecasts

  dotbot Has:

  ✅ Memory (6 tools)
  ✅ Web (3 tools)
  ✅ Files (6 tools)
  ✅ Code execution (1 tool)
  ✅ Browser (7 tools)
  ✅ Images (3 tools)
  ✅ Weather (1 tool)
  ✅ Notifications (1 tool)
  ✅ Messages (4 tools)
  ✅ Goals (9 tools)
  ✅ Triggers (4 tools)

  45 total - well above baseline expectations.

  Missing Common Tools (Consider Adding)

  - Calculator - Math operations (LLMs are bad at precise math)
  - Time/Date - Current time, timezone conversions
  - Email - Send/read emails
  - Database - Direct SQL/NoSQL queries

  Minimal Viable Agent Toolkit

  If starting from scratch, the absolute minimum:

  1. Memory (save/search)
  2. Web search
  3. File read/write
  4. Code execution

  Everything else is optional depending on use case.


Anthropic SDK
  Built-in tools - Read files, run bash commands, edit code, search web, glob patterns. Zero setup needed.
Context management - Automatic compaction, long-running sessions, context windows handled for you.
Agent loop - Built-in gather → action → verify → repeat pattern.
MCP integration - Connect to any MCP server for enterprise tools (Slack, GitHub, Drive, etc).
Hooks - Intercept tool calls, modify behavior, add custom logic.
Subagents - Spawn specialized agents for parallel work.
Permissions - Fine-grained control over what agents can access/modify.
Structured outputs - JSON schema support.


xAI

xai-sdk (Python/TypeScript) - standard client SDK
Agent Tools API - server-side tools (web search, X search, code execution, MCP, file search)
Agentic tool calling - Grok decides when to invoke tools autonomously