type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

let currentLevel: LogLevel = "info";

function shouldLog(level: LogLevel): boolean {
    return levelOrder[level] >= levelOrder[currentLevel];
}

function log(level: LogLevel, message: string, data?: unknown) {
    if (!shouldLog(level)) return;
    const payload = data ? { msg: message, ...normalize(data) } : { msg: message };
    // eslint-disable-next-line no-console
    console[level](`[${level.toUpperCase()}]`, JSON.stringify(payload));
}

function normalize(data: unknown): Record<string, unknown> {
    if (typeof data !== "object" || data === null) return { data };
    try {
        return JSON.parse(JSON.stringify(data));
    } catch {
        return { data: String(data) };
    }
}

export function configureLogger(level?: string | null, runtimeEnv?: string) {
    const normalized = (level || "").toLowerCase();
    if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
        currentLevel = normalized;
        return;
    }
    currentLevel = runtimeEnv === "production" ? "info" : "debug";
}

export const logger = {
    debug(data: unknown, message?: string) {
        if (typeof data === "string") {
            log("debug", data);
        } else {
            log("debug", message || "debug", data);
        }
    },
    info(data: unknown, message?: string) {
        if (typeof data === "string") {
            log("info", data);
        } else {
            log("info", message || "info", data);
        }
    },
    warn(data: unknown, message?: string) {
        if (typeof data === "string") {
            log("warn", data);
        } else {
            log("warn", message || "warn", data);
        }
    },
    error(data: unknown, message?: string) {
        if (typeof data === "string") {
            log("error", data);
        } else {
            log("error", message || "error", data);
        }
    },
};

export type Logger = typeof logger;
