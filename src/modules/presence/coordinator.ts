import { normalizeRoles } from "../gateway/schema.ts";
import type { AccountType } from "../types/account.ts";
import type { AllowedRole } from "../gateway/schema.ts";

export interface PresenceRecord {
    uuid: string;
    name: string;
    accountType: AccountType;
    roles: AllowedRole[];
    online: boolean;
    last_join?: number;
    last_seen?: number;
    last_leave?: number;
    ip?: string | null;
}

type Action =
    | { type: "online"; payload: PresenceRecord }
    | { type: "offline"; payload: { uuid: string; ip?: string | null } }
    | { type: "seen"; payload: { uuid: string } }
    | { type: "roles"; payload: { uuid: string; roles: AllowedRole[] } };

const USER_PREFIX = "user:";

export class PresenceCoordinator implements DurableObject {
    private ready: Promise<void> | null = null;
    private users = new Map<string, PresenceRecord>();

    constructor(private readonly state: DurableObjectState, _env: unknown) {
        this.ready = this.loadFromStorage();
    }

    async fetch(request: Request): Promise<Response> {
        if (this.ready) await this.ready;

        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method.toUpperCase();

        if (method === "POST" && path === "/event") {
            const action = await this.parseAction(request);
            if (!action) return this.json({ ok: false, error: "invalid_payload" }, 400);
            switch (action.type) {
                case "online":
                    await this.handleOnline(action.payload);
                    return this.json({ ok: true });
                case "offline":
                    await this.handleOffline(action.payload.uuid);
                    return this.json({ ok: true });
                case "seen":
                    await this.handleSeen(action.payload.uuid);
                    return this.json({ ok: true });
                case "roles":
                    await this.handleRoles(action.payload.uuid, action.payload.roles);
                    return this.json({ ok: true });
                default:
                    return this.json({ ok: false, error: "unsupported_action" }, 400);
            }
        }

        if (method === "GET" && path === "/snapshot") {
            const users = Array.from(this.users.values()).filter((user) => user.online);
            return this.json({ ok: true, users });
        }

        if (method === "GET" && path === "/count") {
            const onlineUsers = Array.from(this.users.values()).filter((u) => u.online).length;
            return this.json({ ok: true, onlineUsers, uniqueUsers: onlineUsers });
        }

        if (method === "GET" && path === "/roles") {
            const uuid = url.searchParams.get("uuid") || "";
            const record = this.users.get(uuid);
            return this.json({ ok: true, roles: record?.roles ?? null });
        }

        return new Response("Not found", { status: 404 });
    }

    private async parseAction(request: Request): Promise<Action | null> {
        try {
            const data = await request.json() as any;
            if (!data || typeof data.type !== "string") return null;
            switch (data.type) {
                case "online": {
                    const uuid = String(data.payload?.uuid || "").trim();
                    if (!uuid) return null;
                    const roles = normalizeRoles(data.payload?.roles);
                    const record: PresenceRecord = {
                        uuid,
                        name: String(data.payload?.name || "Unknown").trim() || "Unknown",
                        accountType: (String(data.payload?.accountType || "LOCAL").toUpperCase()) as AccountType,
                        roles: roles.length ? roles : ["MEMBER"],
                        online: true,
                        last_join: typeof data.payload?.last_join === "number" ? data.payload.last_join : Date.now(),
                        last_seen: typeof data.payload?.last_seen === "number" ? data.payload.last_seen : Date.now(),
                        ip: typeof data.payload?.ip === "string" || data.payload?.ip === null ? data.payload.ip : null,
                    };
                    return { type: "online", payload: record };
                }
                case "offline": {
                    const uuid = String(data.payload?.uuid || "").trim();
                    if (!uuid) return null;
                    return { type: "offline", payload: { uuid, ip: data.payload?.ip } };
                }
                case "seen": {
                    const uuid = String(data.payload?.uuid || "").trim();
                    if (!uuid) return null;
                    return { type: "seen", payload: { uuid } };
                }
                case "roles": {
                    const uuid = String(data.payload?.uuid || "").trim();
                    if (!uuid) return null;
                    const roles = normalizeRoles(data.payload?.roles);
                    return { type: "roles", payload: { uuid, roles } };
                }
                default:
                    return null;
            }
        } catch {
            return null;
        }
    }

    private async handleOnline(record: PresenceRecord) {
        const now = Date.now();
        const existing = this.users.get(record.uuid);
        const merged: PresenceRecord = {
            ...existing,
            ...record,
            online: true,
            last_join: record.last_join ?? existing?.last_join ?? now,
            last_seen: record.last_seen ?? now,
            last_leave: existing?.last_leave,
        };
        this.users.set(record.uuid, merged);
        await this.state.storage.put(this.storageKey(record.uuid), merged);
    }

    private async handleOffline(uuid: string) {
        const existing = this.users.get(uuid);
        const now = Date.now();
        if (!existing) {
            const record: PresenceRecord = {
                uuid,
                name: "Unknown",
                accountType: "LOCAL",
                roles: ["MEMBER"],
                online: false,
                last_leave: now,
            };
            this.users.set(uuid, record);
            await this.state.storage.put(this.storageKey(uuid), record);
            return;
        }
        const updated: PresenceRecord = { ...existing, online: false, last_leave: now };
        this.users.set(uuid, updated);
        await this.state.storage.put(this.storageKey(uuid), updated);
    }

    private async handleSeen(uuid: string) {
        const existing = this.users.get(uuid);
        const now = Date.now();
        if (!existing) return;
        const updated: PresenceRecord = { ...existing, last_seen: now, online: true };
        this.users.set(uuid, updated);
        await this.state.storage.put(this.storageKey(uuid), updated);
    }

    private async handleRoles(uuid: string, roles: AllowedRole[]) {
        const existing = this.users.get(uuid);
        if (!existing) return;
        const updated: PresenceRecord = { ...existing, roles: roles.length ? roles : existing.roles };
        this.users.set(uuid, updated);
        await this.state.storage.put(this.storageKey(uuid), updated);
    }

    private async loadFromStorage() {
        const list = await this.state.storage.list<PresenceRecord>({ prefix: USER_PREFIX });
        for (const [, value] of list) {
            if (value && value.uuid) {
                this.users.set(value.uuid, value);
            }
        }
    }

    private storageKey(uuid: string) {
        return `${USER_PREFIX}${uuid}`;
    }

    private json(body: unknown, status = 200) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }
}

/**
 * Nova versão do Durable Object de presença.
 *
 * Mantém exatamente o mesmo comportamento de `PresenceCoordinator`,
 * mas usa uma classe diferente para podermos criar um novo DO limpo
 * via nova migration no Wrangler.
 */
export class PresenceCoordinatorV2 extends PresenceCoordinator {}
