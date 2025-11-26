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

/**
 * Cria um novo contexto de aplicação para **cada** request.
 *
 * Em Cloudflare Workers, bindings de I/O (como D1Database, DOs, etc.)
 * não podem ser reutilizados entre diferentes requests. Por isso,
 * evitamos cache global de `env` / clients que guardem esses objetos.
 */
export function createApp(env: EnvBindings & HealthBindings & PresenceBindings): Promise<AppContext> {
    return bootstrap(env);
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
