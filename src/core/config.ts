import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    WS_PATH: z.string().trim().default("/websocket"),
    ADMIN_KEY: z.string().min(16, "ADMIN_KEY must be at least 16 characters long").default("changeme-admin-key"),
    WS_HEARTBEAT_INTERVAL: z.coerce.number().int().positive().default(30000),
    OFFLINE_AFTER_MS: z.coerce.number().int().positive().default(120000),
    FIREBASE_PROJECT_ID: z.string().min(1, "FIREBASE_PROJECT_ID is required"),
    FIREBASE_CLIENT_EMAIL: z.string().email("FIREBASE_CLIENT_EMAIL must be a valid email"),
    FIREBASE_PRIVATE_KEY: z.string().min(1, "FIREBASE_PRIVATE_KEY is required"),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RENDER_INTERNAL_PORT: z.coerce.number().int().positive().optional(),
}).superRefine((data, ctx) => {
    if (!data.WS_PATH.startsWith("/")) {
        ctx.addIssue({
            path: ["WS_PATH"],
            code: z.ZodIssueCode.custom,
            message: "WS_PATH must start with '/'",
        });
    }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
}

const env = parsed.data;

export type AppEnvironment = typeof env;

export const config = {
    env: env.NODE_ENV,
    port: env.RENDER_INTERNAL_PORT ?? env.PORT,
    wsPath: env.WS_PATH,
    adminKey: env.ADMIN_KEY,
    hbInterval: env.WS_HEARTBEAT_INTERVAL,
    offlineAfter: env.OFFLINE_AFTER_MS,
    rateLimit: {
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        max: env.RATE_LIMIT_MAX,
    },
    firebase: {
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY,
    },
} as const;

export type AppConfig = typeof config;
