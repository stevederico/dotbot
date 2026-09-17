/**
 * Zero-dependency terminal UI for dotbot.
 * Alt-screen + raw stdin. No Ink/blessed.
 */

import type { AgentContext, AgentEvent, Message, Provider, ToolDefinition } from '../types.js';

const ESC = '\x1b';
const ENTER_ALT = `${ESC}[?1049h${ESC}[?25l`;
const LEAVE_ALT = `${ESC}[?25h${ESC}[?1049l`;
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;

/** One painted chat line (already wrapped or raw). */
export interface TuiLine {
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
}

/** Dependencies injected by the CLI bootstrap. */
export interface TuiDeps {
  version: string;
  providerId: string;
  model: string;
  sandbox: boolean;
  sessionId: string;
  provider: Provider;
  tools: ToolDefinition[];
  context: AgentContext;
  agentLoop: (opts: {
    model: string;
    messages: Message[];
    tools: ToolDefinition[];
    provider: Provider;
    context: AgentContext;
  }) => AsyncGenerator<AgentEvent, void, unknown>;
  initialMessages?: Message[];
}

/**
 * Word-wrap text to width. Exported for tests.
 */
export function wrapText(text: string, width: number): string[] {
  if (width < 1) width = 1;
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (!line) {
        line = word.length > width ? word.slice(0, width) : word;
        if (word.length > width) {
          out.push(line);
          let rest = word.slice(width);
          while (rest.length > width) {
            out.push(rest.slice(0, width));
            rest = rest.slice(width);
          }
          line = rest;
        }
        continue;
      }
      if (`${line} ${word}`.length <= width) {
        line = `${line} ${word}`;
      } else {
        out.push(line);
        if (word.length > width) {
          let rest = word;
          while (rest.length > width) {
            out.push(rest.slice(0, width));
            rest = rest.slice(width);
          }
          line = rest;
        } else {
          line = word;
        }
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Expand logical lines into painted rows with prefixes.
 */
export function paintRows(lines: TuiLine[], width: number): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    const prefix =
      line.kind === 'user' ? 'you › ' :
      line.kind === 'assistant' ? 'bot › ' :
      line.kind === 'tool' ? 'tool › ' :
      line.kind === 'error' ? 'err › ' :
      '··· › ';
    const inner = Math.max(1, width - prefix.length);
    const wrapped = wrapText(line.text, inner);
    for (let i = 0; i < wrapped.length; i++) {
      rows.push(i === 0 ? `${prefix}${wrapped[i]}` : `${' '.repeat(prefix.length)}${wrapped[i]}`);
    }
  }
  return rows;
}

/**
 * Slice rows to fit the chat viewport (show bottom by default).
 */
export function visibleRows(rows: string[], height: number, scrollUp: number): string[] {
  if (height <= 0) return [];
  const maxScroll = Math.max(0, rows.length - height);
  const scroll = Math.min(Math.max(0, scrollUp), maxScroll);
  const end = rows.length - scroll;
  const start = Math.max(0, end - height);
  return rows.slice(start, end);
}

function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

function write(s: string): void {
  process.stdout.write(s);
}

/**
 * Run the alt-screen TUI until exit.
 */
export async function runTui(deps: TuiDeps): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('dotbot tui requires an interactive TTY');
  }

  let model = deps.model;
  const messages: Message[] = [...(deps.initialMessages ?? [])];
  const log: TuiLine[] = [];
  let input = '';
  let status = 'ready';
  let scrollUp = 0;
  let busy = false;
  let closed = false;

  // Seed log from prior session messages (plain text only)
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      log.push({ kind: 'user', text: m.content });
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
      log.push({ kind: 'assistant', text: m.content });
    }
  }

  const render = (): void => {
    const { cols, rows } = termSize();
    const headerH = 2;
    const footerH = 3; // status + blank + input
    const chatH = Math.max(3, rows - headerH - footerH);
    const painted = paintRows(log, cols);
    const view = visibleRows(painted, chatH, scrollUp);

    write(CLEAR + HIDE);
    const sandbox = deps.sandbox ? ' sandbox' : '';
    write(`dotbot tui v${deps.version}  ${deps.providerId}/${model}${sandbox}\n`);
    write(`session ${deps.sessionId.slice(0, 8)}…  /help  ctrl+c quit\n`);

    for (let i = 0; i < chatH; i++) {
      const row = view[i] ?? '';
      write(`${row.padEnd(cols).slice(0, cols)}\n`);
    }

    const statusLine = status.length > cols ? status.slice(0, cols - 1) + '…' : status;
    write(`${statusLine.padEnd(cols).slice(0, cols)}\n`);
    write('\n');
    const prompt = `› ${input}`;
    write(`${prompt.padEnd(cols).slice(0, cols)}`);
    write(`${ESC}[${rows};${Math.min(cols, prompt.length + 1)}H${SHOW}`);
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch { /* ok */ }
    process.stdin.pause();
    write(LEAVE_ALT);
  };

  const onResize = (): void => {
    render();
  };

  process.stdout.on('resize', onResize);
  write(ENTER_ALT);
  render();

  const exit = (code = 0): void => {
    cleanup();
    process.stdout.off('resize', onResize);
    process.exit(code);
  };

  const runTurn = async (text: string): Promise<void> => {
    busy = true;
    status = 'thinking…';
    log.push({ kind: 'user', text });
    messages.push({ role: 'user', content: text });
    scrollUp = 0;
    render();

    let assistant = '';
    let assistantIdx = -1;

    try {
      for await (const event of deps.agentLoop({
        model,
        messages: [...messages],
        tools: deps.tools,
        provider: deps.provider,
        context: deps.context,
      })) {
        switch (event.type) {
          case 'thinking':
            status = 'thinking…';
            render();
            break;
          case 'text_delta':
            if (assistantIdx < 0) {
              log.push({ kind: 'assistant', text: '' });
              assistantIdx = log.length - 1;
            }
            assistant += event.text;
            log[assistantIdx] = { kind: 'assistant', text: assistant };
            status = 'streaming…';
            render();
            break;
          case 'tool_start':
            status = `tool ${event.name}…`;
            log.push({ kind: 'tool', text: `${event.name}` });
            render();
            break;
          case 'tool_result':
            status = `tool ${event.name} done`;
            {
              const preview = (event.result || '').replace(/\s+/g, ' ').slice(0, 120);
              log.push({ kind: 'tool', text: `${event.name} → ${preview}` });
            }
            render();
            break;
          case 'tool_error':
            status = `tool ${event.name} error`;
            log.push({ kind: 'error', text: `${event.name}: ${event.error}` });
            render();
            break;
          case 'error':
            status = 'error';
            log.push({ kind: 'error', text: event.error || 'agent error' });
            render();
            break;
          case 'max_iterations':
            status = 'max turns';
            log.push({ kind: 'system', text: event.message || 'max iterations' });
            render();
            break;
          case 'done':
            if (typeof event.content === 'string' && event.content && !assistant) {
              assistant = event.content;
              log.push({ kind: 'assistant', text: assistant });
            }
            break;
          default:
            break;
        }
      }

      if (assistant) {
        messages.push({ role: 'assistant', content: assistant });
      }
      status = 'ready';
    } catch (err) {
      status = 'error';
      log.push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
      render();
    }
  };

  const handleCommand = async (raw: string): Promise<boolean> => {
    const cmd = raw.trim();
    if (cmd === '/bye' || cmd === '/quit' || cmd === '/exit') {
      exit(0);
      return true;
    }
    if (cmd === '/help' || cmd === '/?') {
      log.push({
        kind: 'system',
        text: 'commands: /help /clear /show /load <model> /bye · enter sends · pgup/pgdn scroll',
      });
      render();
      return true;
    }
    if (cmd === '/clear') {
      messages.length = 0;
      log.length = 0;
      scrollUp = 0;
      status = 'cleared';
      render();
      return true;
    }
    if (cmd === '/show') {
      log.push({
        kind: 'system',
        text: `provider=${deps.providerId} model=${model} session=${deps.sessionId}`,
      });
      render();
      return true;
    }
    if (cmd.startsWith('/load ')) {
      const next = cmd.slice(6).trim();
      if (next) {
        model = next;
        status = `model ${model}`;
        log.push({ kind: 'system', text: `switched to ${model}` });
      }
      render();
      return true;
    }
    return false;
  };

  await new Promise<void>((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (chunk: string): void => {
      if (closed) return;

      // ctrl+c
      if (chunk === '\u0003') {
        process.stdin.off('data', onData);
        cleanup();
        process.stdout.off('resize', onResize);
        resolve();
        process.exit(0);
        return;
      }
      // ctrl+d with empty input
      if (chunk === '\u0004' && !input) {
        process.stdin.off('data', onData);
        cleanup();
        process.stdout.off('resize', onResize);
        resolve();
        process.exit(0);
        return;
      }

      // ignore input while busy except ctrl+c already handled
      if (busy) return;

      // enter
      if (chunk === '\r' || chunk === '\n') {
        const text = input;
        input = '';
        void (async () => {
          if (!text.trim()) {
            render();
            return;
          }
          if (await handleCommand(text)) return;
          await runTurn(text.trim());
        })();
        return;
      }

      // backspace
      if (chunk === '\u007f' || chunk === '\b') {
        input = input.slice(0, -1);
        render();
        return;
      }

      // page up / page down (CSI sequences)
      if (chunk === `${ESC}[5~`) {
        scrollUp += 5;
        render();
        return;
      }
      if (chunk === `${ESC}[6~`) {
        scrollUp = Math.max(0, scrollUp - 5);
        render();
        return;
      }

      // ignore other escapes
      if (chunk.startsWith(ESC)) return;

      // printable (incl. paste of multi-char)
      for (const ch of chunk) {
        if (ch >= ' ' || ch === '\t') input += ch;
      }
      render();
    };

    process.stdin.on('data', onData);
  });
}
