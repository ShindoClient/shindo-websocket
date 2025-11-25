import { loadConfig, type AppConfig, type EnvBindings } from "./config.ts";
import { configureLogger, logger } from "./logger.ts";
import { registerGateway, type Gateway } from "../modules/gateway/gateway.ts";
import { registerPlugins } from "../plugins/index.ts";
import type { HealthBindings } from "../modules/health/service.ts";
import type { PresenceBindings } from "../modules/presence/service.ts";

export interface AppContext extends Gateway {
    config: AppConfig;
    env: EnvBindings & HealthBindings & PresenceBindings;
}

let cachedContext: Promise<AppContext> | null = null;

export function createApp(env: EnvBindings & HealthBindings & PresenceBindings): Promise<AppContext> {
    if (!cachedContext) {
        cachedContext = bootstrap(env);
    }
    return cachedContext;
}

async function bootstrap(env: EnvBindings & HealthBindings & PresenceBindings): Promise<AppContext> {
    const config = loadConfig(env);
    configureLogger(env.LOG_LEVEL, config.env);

    const gateway = registerGateway(env);
    const context: AppContext = { ...gateway, config, env };

    await registerPlugins(context);
    logger.info({ path: config.wsPath, env: config.env }, "Gateway initialized for Cloudflare Workers");
    return context;
}
