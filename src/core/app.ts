import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { initFirebase } from "./firebase.ts";
import { registerGateway, type Gateway } from "../modules/gateway/gateway.ts";
import { registerPlugins } from "../plugins/index.ts";

export interface AppContext extends Gateway {
    server: Deno.Server;
}

export async function bootstrap(): Promise<AppContext> {
    initFirebase();

    const gateway = registerGateway();
    const server = Deno.serve({ port: config.port, hostname: "0.0.0.0" }, (req, info) => gateway.handleRequest(req, info));
    const context: AppContext = { ...gateway, server };

    await registerPlugins(context);
    logger.info({ port: config.port, path: config.wsPath }, "Gateway listening on Deno");

    return context;
}
