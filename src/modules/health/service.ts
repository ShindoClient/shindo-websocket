import { config } from "../../core/config.ts";
import { firestore } from "../../core/firebase.ts";
import { logger } from "../../core/logger.ts";

const HEALTH_COLLECTION = "health";
const HEALTH_DOCUMENT_ID = config.env === "production" ? "websocket" : `websocket-${config.env}`;

async function readPersistedStartTime(): Promise<number | null> {
    const client = firestore();
    try {
        const snapshot = await client
            .collection(HEALTH_COLLECTION)
            .doc(HEALTH_DOCUMENT_ID)
            .get();

        if (!snapshot.exists) {
            return null;
        }

        const data = snapshot.data() as { started_at?: unknown };
        const raw = typeof data?.started_at === "string" ? data.started_at : null;
        const parsed = raw ? Date.parse(raw) : Number.NaN;
        return Number.isNaN(parsed) ? null : parsed;
    } catch (error) {
        logger.error({ err: error }, "Failed to read websocket start time from Firestore");
        return null;
    }
}

export async function persistWebsocketStartTime(startTimeMs: number): Promise<number> {
    const client = firestore();
    const startedAt = new Date(startTimeMs).toISOString();
    const now = new Date().toISOString();

    try {
        await client
            .collection(HEALTH_COLLECTION)
            .doc(HEALTH_DOCUMENT_ID)
            .set(
                {
                    env: config.env,
                    started_at: startedAt,
                    last_update: now,
                },
                { merge: true },
            );
        return startTimeMs;
    } catch (error) {
        logger.error({ err: error }, "Failed to persist websocket start time to Firestore");
        const existing = await readPersistedStartTime();
        return existing ?? startTimeMs;
    }
}

export async function getPersistedStartTime(): Promise<number | null> {
    return readPersistedStartTime();
}
