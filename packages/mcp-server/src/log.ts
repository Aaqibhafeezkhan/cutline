// All logs go to stderr: stdout belongs to the MCP stdio transport.
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.CUTLINE_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

function write(level: Level, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const line = `[cutline] ${level.padEnd(5)} ${msg}`;
  if (extra !== undefined) console.error(line, extra);
  else console.error(line);
}

export const log = {
  debug: (msg: string, extra?: unknown) => write('debug', msg, extra),
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
