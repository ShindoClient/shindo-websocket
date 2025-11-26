import { createApp } from "./core/app.ts";
import type { EnvBindings } from "./core/config.ts";
import type { HealthBindings } from "./modules/health/service.ts";
import type { PresenceBindings } from "./modules/presence/service.ts";
import { logger } from "./core/logger.ts";
import type { RequestMeta } from "./modules/gateway/gateway.ts";
export { PresenceCoordinatorV2 } from "./modules/presence/coordinator.ts";

export interface Env extends EnvBindings, HealthBindings, PresenceBindings {}

export default {
    async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        try {
            const app = await createApp(env);
            const meta: RequestMeta = { clientIp: resolveClientIp(req) };
            return await app.handleRequest(req, meta);
        } catch (error) {
            logger.error({ err: error }, "Failed to handle request");
            return new Response("Internal Server Error", { status: 500 });
        }
    },
};

addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    logger.error({ err: event.reason }, "Unhandled promise rejection");
});

addEventListener("error", (event: ErrorEvent) => {
    logger.error({ err: event.error }, "Uncaught exception");
});

function resolveClientIp(req: Request): string | null {
    const forwarded = req.headers.get("cf-connecting-ip")
        || req.headers.get("x-real-ip")
        || req.headers.get("x-forwarded-for");

    if (!forwarded) return null;
    return forwarded.split(",")[0]?.trim() || null;
}
