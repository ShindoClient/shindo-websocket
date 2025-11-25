import { logger } from "../../core/logger.ts";

const START_KEY = "health:started_at";

export interface HealthBindings {
    APP_KV: KVNamespace;
}

export async function persistWebsocketStartTime(env: HealthBindings, startTimeMs: number): Promise<number> {
    try {
        const existingRaw = await env.APP_KV.get(START_KEY);
        const existing = existingRaw ? Number(existingRaw) : NaN;
        if (!Number.isNaN(existing) && existing > 0) {
            // Touch last update without overriding the start time.
            await env.APP_KV.put(`${START_KEY}:last_update`, Date.now().toString());
            return existing;
        }

        await env.APP_KV.put(START_KEY, String(startTimeMs));
        await env.APP_KV.put(`${START_KEY}:last_update`, Date.now().toString());
        return startTimeMs;
    } catch (error) {
        logger.warn({ err: error }, "Failed to persist start time to KV; falling back to runtime value");
        const fallback = await getPersistedStartTime(env);
        return fallback ?? startTimeMs;
    }
}

export async function getPersistedStartTime(env: HealthBindings): Promise<number | null> {
    try {
        const raw = await env.APP_KV.get(START_KEY);
        const value = raw ? Number(raw) : NaN;
        return Number.isNaN(value) ? null : value;
    } catch (error) {
        logger.warn({ err: error }, "Failed to read start time from KV");
        return null;
    }
}
