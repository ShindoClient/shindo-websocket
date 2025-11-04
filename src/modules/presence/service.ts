import { firestore } from "../../core/firebase.js";
import { logger } from "../../core/logger.js";
import type { AccountType } from "../types/account.js";

const USERS_COLLECTION = "users";

export interface PresenceRecord {
    uuid: string;
    name: string;
    roles?: string[];
    accountType: AccountType;
}

export async function markOnline(record: PresenceRecord, rolesToPersist?: string[]) {
    const client = firestore();
    const now = new Date().toISOString();

    const payload = {
        uuid: record.uuid,
        name: record.name,
        account_type: record.accountType,
        online: true,
        last_join: now,
        last_seen: now,
        roles: rolesToPersist ?? record.roles ?? [],
    };

    try {
        await client
            .collection(USERS_COLLECTION)
            .doc(record.uuid)
            .set(payload, { merge: true });
    } catch (error) {
        logger.error({ err: error, uuid: record.uuid }, "Failed to mark user online");
        throw error;
    }
}

export async function updateLastSeen(uuid: string) {
    const client = firestore();
    const now = new Date().toISOString();

    try {
        await client
            .collection(USERS_COLLECTION)
            .doc(uuid)
            .set({ last_seen: now }, { merge: true });
    } catch (error) {
        logger.error({ err: error, uuid }, "Failed to update last seen");
        throw error;
    }
}

export async function markOffline(uuid: string) {
    const client = firestore();
    const now = new Date().toISOString();

    try {
        await client
            .collection(USERS_COLLECTION)
            .doc(uuid)
            .set({
                online: false,
                last_leave: now,
            }, { merge: true });
    } catch (error) {
        logger.error({ err: error, uuid }, "Failed to mark user offline");
        throw error;
    }
}

export async function fetchRoles(uuid: string): Promise<string[] | undefined> {
    const client = firestore();
    try {
        const snapshot = await client
            .collection(USERS_COLLECTION)
            .doc(uuid)
            .get();

        if (!snapshot.exists) {
            return undefined;
        }

        const data = snapshot.data() as { roles?: unknown };
        const roles = Array.isArray(data?.roles) ? data?.roles.filter((role): role is string => typeof role === "string") : undefined;
        return roles && roles.length ? roles : undefined;
    } catch (error) {
        logger.error({ err: error, uuid }, "Failed to fetch user roles from Firestore");
        throw error;
    }
}
