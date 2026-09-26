import pino from "pino";
import type { AgentLogger } from "@gigpilot/agents";

/**
 * Structured JSON logs. Secrets never reach the logger: known secret-bearing
 * fields are redacted defensively and error text is passed through the
 * agents' safeError() before it is logged.
 */
export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): pino.Logger {
  return pino({
    level,
    base: { service: "gigpilot-worker", pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "authorization",
        "headers.authorization",
        "req.headers.authorization",
        "*.token",
        "*.apiKey",
        "*.api_key",
        "*.password",
        "*.secret",
        "*.DATABASE_URL",
        "*.ciphertext",
      ],
      censor: "[redacted]",
    },
    formatters: { level: (label) => ({ level: label }) },
  });
}

export function agentLogger(log: pino.Logger): AgentLogger {
  return {
    debug: (obj, msg) => log.debug(obj, msg),
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
    error: (obj, msg) => log.error(obj, msg),
  };
}
