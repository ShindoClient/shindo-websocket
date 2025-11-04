import pino from "pino";

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

export const logger = pino({
    level,
    base: {
        service: "shindo-websocket",
        env: process.env.NODE_ENV || "development",
    },
    redact: ["req.headers.authorization", "authorization", "firebase"],
});

export type Logger = typeof logger;
