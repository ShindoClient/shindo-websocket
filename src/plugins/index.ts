import type { AppContext } from "../core/app.ts";
import { logger } from "../core/logger.ts";

export interface GatewayPlugin {
    name: string;
    register(context: AppContext): void | Promise<void>;
}

const registeredPlugins: GatewayPlugin[] = [];

export function usePlugin(plugin: GatewayPlugin) {
    registeredPlugins.push(plugin);
}

export async function registerPlugins(context: AppContext) {
    for (const plugin of registeredPlugins) {
        try {
            await plugin.register(context);
            logger.info({ plugin: plugin.name }, "Plugin registered");
        } catch (error) {
            logger.error({ err: error, plugin: plugin.name }, "Failed to register plugin");
        }
    }
}
