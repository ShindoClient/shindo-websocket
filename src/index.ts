import "dotenv/config";
import { bootstrap } from "./core/app.js";
import { logger } from "./core/logger.js";

bootstrap().catch((error) => {
    logger.error({ err: error }, "Failed to bootstrap Shindo gateway");
    process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "Uncaught exception");
});
