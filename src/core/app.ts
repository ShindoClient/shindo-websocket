import { loadConfig, type AppConfig, type EnvBindings } from "./config.ts";
import { configureLogger, logger } from "./logger.ts";
import { initFirebase } from "./firebase.ts";
import { registerGateway, type Gateway } from "../modules/gateway/gateway.ts";
import { registerPlugins } from "../plugins/index.ts";

export interface AppContext extends Gateway {
    config: AppConfig;
}

let cachedContext: Promise<AppContext> | null = null;

export function createApp(env: EnvBindings): Promise<AppContext> {
    if (!cachedContext) {
        cachedContext = bootstrap(env);
    }
    return cachedContext;
}

async function bootstrap(env: EnvBindings): Promise<AppContext> {
    const config = loadConfig(env);
    configureLogger(env.LOG_LEVEL, config.env);
    initFirebase();

    const gateway = registerGateway();
    const context: AppContext = { ...gateway, config };

    await registerPlugins(context);
    logger.info({ path: config.wsPath, env: config.env }, "Gateway initialized for Cloudflare Workers");
    return context;
}
