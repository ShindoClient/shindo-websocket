import type { AllowedRole } from "../gateway/schema.ts";
import type { AccountType } from "../types/account.ts";

export interface PresenceRecord {
    uuid: string;
    name: string;
    roles?: AllowedRole[];
    accountType: AccountType;
    ip?: string | null;
}

export interface PresenceSnapshot {
    uuid: string;
    name: string;
    roles: AllowedRole[];
    accountType: AccountType;
    online: boolean;
    last_join?: number;
    last_seen?: number;
    last_leave?: number;
}

export interface PresenceBindings {
    PRESENCE_DO: DurableObjectNamespace;
}

export interface PresenceClient {
    markOnline(record: PresenceRecord): Promise<void>;
    updateLastSeen(uuid: string): Promise<void>;
    markOffline(uuid: string): Promise<void>;
    fetchRoles(uuid: string): Promise<AllowedRole[] | undefined>;
    fetchOnlineUsers(limit?: number): Promise<PresenceSnapshot[]>;
    countOnlineUsers(): Promise<number>;
    updateRoles(uuid: string, roles: AllowedRole[]): Promise<void>;
}

export function createPresenceClient(env: PresenceBindings): PresenceClient {
    const stub = env.PRESENCE_DO.get(env.PRESENCE_DO.idFromName("presence"));

    async function post(action: string, payload: Record<string, unknown>) {
        const res = await stub.fetch("https://presence/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: action, payload }),
        });
        if (!res.ok) {
            throw new Error(`Presence DO rejected action ${action}: ${res.status}`);
        }
    }

    return {
        async markOnline(record) {
            await post("online", {
                ...record,
                roles: record.roles ?? [],
                last_join: Date.now(),
                last_seen: Date.now(),
            });
        },
        async updateLastSeen(uuid) {
            await post("seen", { uuid });
        },
        async markOffline(uuid) {
            await post("offline", { uuid });
        },
        async fetchRoles(uuid) {
            const url = new URL("https://presence/roles");
            url.searchParams.set("uuid", uuid);
            const res = await stub.fetch(url.toString());
            if (!res.ok) return undefined;
            const payload = await res.json() as { roles?: AllowedRole[] | null };
            return Array.isArray(payload.roles) ? payload.roles as AllowedRole[] : undefined;
        },
        async fetchOnlineUsers(limit = 500) {
            const res = await stub.fetch("https://presence/snapshot");
            if (!res.ok) return [];
            const payload = await res.json() as { users?: PresenceSnapshot[] };
            const list = Array.isArray(payload.users) ? payload.users : [];
            return list.slice(0, limit);
        },
        async countOnlineUsers() {
            const res = await stub.fetch("https://presence/count");
            if (!res.ok) return 0;
            const payload = await res.json() as { onlineUsers?: number };
            return typeof payload.onlineUsers === "number" ? payload.onlineUsers : 0;
        },
        async updateRoles(uuid, roles) {
            await post("roles", { uuid, roles });
        },
    };
}
