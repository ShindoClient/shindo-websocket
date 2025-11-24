import { bootstrap } from "./core/app.ts";
import { logger } from "./core/logger.ts";

try {
    await bootstrap();
} catch (error) {
    logger.error({ err: error }, "Failed to bootstrap Shindo gateway");
    throw error;
}

addEventListener("unhandledrejection", (event) => {
    logger.error({ err: event.reason }, "Unhandled promise rejection");
});

addEventListener("error", (event) => {
    logger.error({ err: event.error }, "Uncaught exception");
});
