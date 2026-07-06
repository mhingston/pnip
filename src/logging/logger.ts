import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SerializableError {
  name: string;
  message: string;
  stack?: string;
  provider?: unknown;
  providerMetadata?: unknown;
  retryCount?: number;
}

export interface LogFields {
  worker?: string;
  jobId?: string;
  editionId?: string;
  documentId?: string;
  stage?: string;
  correlationId?: string;
  durationMs?: number;
  retryCount?: number;
  error?: Error | SerializableError;
  provider?: unknown;
  providerMetadata?: unknown;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(partial: LogFields): Logger;
}

export interface CreateLoggerOptions {
  sink?: (line: string) => void;
  level?: LogLevel;
  baseFields?: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function defaultLevel(): LogLevel {
  return loadConfig().LOG_LEVEL;
}

function normalizeError(error: Error | SerializableError): {
  error: { type: string; message: string; stack?: string };
  retryCount?: number;
  provider?: unknown;
} {
  const e: {
    name: string;
    message: string;
    stack?: string;
    provider?: unknown;
    providerMetadata?: unknown;
    retryCount?: number;
  } = error;
  const result: {
    error: { type: string; message: string; stack?: string };
    retryCount?: number;
    provider?: unknown;
  } = { error: { type: e.name, message: e.message, stack: e.stack } };
  if (e.retryCount !== undefined) result.retryCount = e.retryCount;
  if (e.provider !== undefined) result.provider = e.provider;
  else if (e.providerMetadata !== undefined) result.provider = e.providerMetadata;
  return result;
}

function createLoggerInstance(
  sink: (line: string) => void,
  level: LogLevel | undefined,
  fields: LogFields,
): Logger {
  const minLevel = level ?? defaultLevel();
  const context: LogFields =
    fields.correlationId === undefined
      ? { ...fields, correlationId: randomUUID() }
      : { ...fields };

  function emit(callLevel: LogLevel, message: string, callFields?: LogFields): void {
    if (LEVEL_ORDER[callLevel] < LEVEL_ORDER[minLevel]) return;

    const record: Record<string, unknown> = { ...context };
    if (callFields) {
      const { error, ...rest } = callFields;
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) record[key] = value;
      }
      if (error) {
        const norm = normalizeError(error);
        record.error = norm.error;
        if (norm.retryCount !== undefined && record.retryCount === undefined) {
          record.retryCount = norm.retryCount;
        }
        if (norm.provider !== undefined && record.provider === undefined) {
          record.provider = norm.provider;
        }
      }
    }

    record.timestamp = new Date().toISOString();
    record.level = callLevel;
    record.message = message;

    sink(JSON.stringify(record) + "\n");
  }

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (partial) => createLoggerInstance(sink, level, { ...context, ...partial }),
  };
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line));
  return createLoggerInstance(sink, opts.level, opts.baseFields ?? {});
}
