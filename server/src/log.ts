/** Minimal structured logger: one JSON object per line on stdout/stderr. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel, base: Fields = {}, sink?: (line: string, level: LogLevel) => void): Logger {
  const write = sink ?? ((line: string, lvl: LogLevel) => (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n'));
  const emit = (lvl: LogLevel, msg: string, fields?: Fields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const rec: Fields = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    if (rec.err instanceof Error) rec.err = { name: rec.err.name, message: rec.err.message, stack: rec.err.stack };
    write(JSON.stringify(rec), lvl);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }, sink),
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = createLogger('error', {}, () => {});
