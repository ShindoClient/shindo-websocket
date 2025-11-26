import { logger } from "../../core/logger.ts";

const START_KEY = "health:started_at";

export interface HealthBindings {
    APP_KV: KVNamespace;
    // Opcional: usado para "fixar" o startedAt por versão de deploy.
    COMMIT_HASH?: string;
}

export async function persistWebsocketStartTime(env: HealthBindings, startTimeMs: number): Promise<number> {
    try {
        const commitHash = env.COMMIT_HASH || "dev";

        // Tenta ler o valor existente (formato novo: JSON; formato antigo: número plain).
        let existingStartedAt: number | null = null;
        let existingCommit: string | null = null;
        try {
            const rawJson = await env.APP_KV.get(START_KEY, "json");
            if (rawJson && typeof rawJson === "object") {
                const obj = rawJson as { startedAtMs?: unknown; commitHash?: unknown };
                if (typeof obj.startedAtMs === "number") {
                    existingStartedAt = obj.startedAtMs;
                }
                if (typeof obj.commitHash === "string") {
                    existingCommit = obj.commitHash;
                }
            }
        } catch {
            // Ignora, pode ser formato antigo.
        }

        if (existingStartedAt === null) {
            const legacyRaw = await env.APP_KV.get(START_KEY);
            const legacyNum = legacyRaw ? Number(legacyRaw) : NaN;
            if (!Number.isNaN(legacyNum) && legacyNum > 0) {
                existingStartedAt = legacyNum;
            }
        }

        // Se já existe um startedAt para o mesmo commit, apenas reutiliza (não sobrescreve em cold start).
        if (existingStartedAt !== null && existingCommit === commitHash) {
            await env.APP_KV.put(`${START_KEY}:last_update`, Date.now().toString());
            return existingStartedAt;
        }

        const payload = JSON.stringify({ startedAtMs: startTimeMs, commitHash });
        await env.APP_KV.put(START_KEY, payload);
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
        // Formato novo (JSON).
        const rawJson = await env.APP_KV.get(START_KEY, "json");
        if (rawJson && typeof rawJson === "object") {
            const obj = rawJson as { startedAtMs?: unknown };
            if (typeof obj.startedAtMs === "number") {
                return obj.startedAtMs;
            }
        }

        // Fallback para formato antigo (number plain).
        const raw = await env.APP_KV.get(START_KEY);
        const value = raw ? Number(raw) : NaN;
        return Number.isNaN(value) ? null : value;
    } catch (error) {
        logger.warn({ err: error }, "Failed to read start time from KV");
        return null;
    }
}
