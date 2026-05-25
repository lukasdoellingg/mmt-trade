/**
 * Structured JSON logging for the MMT-Trade backend.
 */

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LOG_LEVELS[raw] ?? LOG_LEVELS.info;
}

function shouldLog(level) {
  return LOG_LEVELS[level] <= currentLevel();
}

function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/token=[^&\s]+/gi, 'token=REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer REDACTED');
}

/**
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 * @param {unknown} [err]
 */
export function log(level, message, context, err) {
  if (!shouldLog(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'mmt-trade-backend',
    msg: redactSecrets(message),
  };
  if (context && typeof context === 'object') entry.ctx = context;
  if (err instanceof Error) {
    entry.err = redactSecrets(err.message);
    if (level === 'error' && process.env.LOG_STACK === '1') entry.stack = err.stack;
  } else if (err !== undefined) {
    entry.err = redactSecrets(String(err));
  }
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function logInfo(message, context) {
  log('info', message, context);
}

export function logWarn(message, context, err) {
  log('warn', message, context, err);
}

export function logError(message, context, err) {
  log('error', message, context, err);
}

export function installProcessErrorHandlers(onFatal) {
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', {}, reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', {}, err);
    if (typeof onFatal === 'function') onFatal(err);
    else process.exit(1);
  });
}
