type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[configured] ?? ORDER.info;
}

/**
 * Structured logs, with one hard rule: no key material, no signature bytes, no
 * canonical payloads. Section 136 asks for crypto observability; a log line
 * that contains a private key is not observability, it is a key leak with a
 * timestamp.
 */
function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
