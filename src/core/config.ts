import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    WS_PATH: z.string().trim().default("/websocket"),
    ADMIN_KEY: z.string().min(16, "ADMIN_KEY must be at least 16 characters long").default("changeme-admin-key"),
    WS_HEARTBEAT_INTERVAL: z.coerce.number().int().positive().default(30000),
    OFFLINE_AFTER_MS: z.coerce.number().int().positive().default(120000),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    LOG_LEVEL: z.string().trim().optional(),
    COMMIT_HASH: z.string().trim().optional(),
}).superRefine((data, ctx) => {
    if (!data.WS_PATH.startsWith("/")) {
        ctx.addIssue({
            path: ["WS_PATH"],
            code: z.ZodIssueCode.custom,
            message: "WS_PATH must start with '/'",
        });
    }
});

export interface EnvBindings {
    NODE_ENV?: string;
    PORT?: string | number;
    WS_PATH?: string;
    ADMIN_KEY?: string;
    WS_HEARTBEAT_INTERVAL?: string | number;
    OFFLINE_AFTER_MS?: string | number;
    RATE_LIMIT_WINDOW_MS?: string | number;
    RATE_LIMIT_MAX?: string | number;
    LOG_LEVEL?: string;
    COMMIT_HASH?: string;
}

export interface AppConfig {
    env: "development" | "test" | "production";
    port: number;
    wsPath: string;
    adminKey: string;
    hbInterval: number;
    offlineAfter: number;
    rateLimit: {
        windowMs: number;
        max: number;
    };
    logLevel?: string;
    commitHash: string;
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(env: EnvBindings): AppConfig {
    const parsed = envSchema.safeParse(env);

    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`);
        throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
    }

    const data = parsed.data;
    cachedConfig = {
        env: data.NODE_ENV,
        port: data.PORT,
        wsPath: data.WS_PATH,
        adminKey: data.ADMIN_KEY,
        hbInterval: data.WS_HEARTBEAT_INTERVAL,
        offlineAfter: data.OFFLINE_AFTER_MS,
        rateLimit: {
            windowMs: data.RATE_LIMIT_WINDOW_MS,
            max: data.RATE_LIMIT_MAX,
        },
        logLevel: data.LOG_LEVEL,
        commitHash: data.COMMIT_HASH ?? "dev",
    } as const;

    return cachedConfig;
}

export function getConfig(): AppConfig {
    if (!cachedConfig) {
        throw new Error("Config not initialized. Call loadConfig(env) first.");
    }
    return cachedConfig;
}
