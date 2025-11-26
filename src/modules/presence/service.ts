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

/**
 * Bindings de presença baseados em D1.
 *
 * Certifique-se de definir este binding no `wrangler.toml`:
 *
 * [[d1_databases]]
 * binding = "PRESENCE_DB"
 * database_name = "seu_nome_de_db"
 * database_id = "seu_id_de_db"
 */
export interface PresenceBindings {
    PRESENCE_DB: D1Database;
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

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS presence (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_type TEXT NOT NULL,
    roles TEXT NOT NULL,
    online INTEGER NOT NULL,
    last_join INTEGER,
    last_seen INTEGER,
    last_leave INTEGER,
    ip TEXT
);
`;

function serializeRoles(roles: AllowedRole[] | undefined | null): string {
    return JSON.stringify(Array.isArray(roles) ? roles : []);
}

function deserializeRoles(raw: unknown): AllowedRole[] {
    if (typeof raw !== "string") return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as AllowedRole[] : [];
    } catch {
        return [];
    }
}

export function createPresenceClient(env: PresenceBindings): PresenceClient {
    const db = env.PRESENCE_DB;
    let ready: Promise<void> | null = null;

    async function ensureSchema() {
        if (!ready) {
            ready = (async () => {
                await db.exec(SCHEMA_SQL);
            })();
        }
        return ready;
    }

    return {
        async markOnline(record) {
            await ensureSchema();
            const now = Date.now();
            const rolesJson = serializeRoles(record.roles);
            const stmt = db.prepare(`
                INSERT INTO presence (uuid, name, account_type, roles, online, last_join, last_seen, ip)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT(uuid) DO UPDATE SET
                    name = excluded.name,
                    account_type = excluded.account_type,
                    roles = excluded.roles,
                    online = 1,
                    last_join = COALESCE(presence.last_join, excluded.last_join),
                    last_seen = excluded.last_seen,
                    ip = excluded.ip
            `);
            await stmt.bind(
                record.uuid,
                record.name,
                record.accountType,
                rolesJson,
                now,
                now,
                record.ip ?? null,
            ).run();
        },
        async updateLastSeen(uuid) {
            await ensureSchema();
            const now = Date.now();
            const stmt = db.prepare(`
                UPDATE presence
                SET last_seen = ?, online = 1
                WHERE uuid = ?
            `);
            await stmt.bind(now, uuid).run();
        },
        async markOffline(uuid) {
            await ensureSchema();
            const now = Date.now();
            const stmt = db.prepare(`
                INSERT INTO presence (uuid, name, account_type, roles, online, last_leave)
                VALUES (?, 'Unknown', 'LOCAL', '["MEMBER"]', 0, ?)
                ON CONFLICT(uuid) DO UPDATE SET
                    online = 0,
                    last_leave = excluded.last_leave
            `);
            await stmt.bind(uuid, now).run();
        },
        async fetchRoles(uuid) {
            await ensureSchema();
            const stmt = db.prepare(`
                SELECT roles FROM presence WHERE uuid = ?
            `);
            const row = await stmt.bind(uuid).first<{ roles: string }>();
            if (!row || typeof row.roles !== "string") return undefined;
            const roles = deserializeRoles(row.roles);
            return roles.length ? roles as AllowedRole[] : undefined;
        },
        async fetchOnlineUsers(limit = 500) {
            await ensureSchema();
            const stmt = db.prepare(`
                SELECT
                    uuid,
                    name,
                    account_type as accountType,
                    roles,
                    online,
                    last_join,
                    last_seen,
                    last_leave
                FROM presence
                WHERE online = 1
                ORDER BY last_seen DESC
                LIMIT ?
            `);
            const result = await stmt.bind(limit).all<{
                uuid: string;
                name: string;
                accountType: AccountType;
                roles: string;
                online: number;
                last_join?: number;
                last_seen?: number;
                last_leave?: number;
            }>();
            const rows = result.results ?? [];
            return rows.map((row) => ({
                uuid: row.uuid,
                name: row.name,
                accountType: row.accountType,
                roles: deserializeRoles(row.roles),
                online: row.online === 1,
                last_join: row.last_join,
                last_seen: row.last_seen,
                last_leave: row.last_leave,
            }));
        },
        async countOnlineUsers() {
            await ensureSchema();
            const stmt = db.prepare(`
                SELECT COUNT(*) as count FROM presence WHERE online = 1
            `);
            const row = await stmt.first<{ count: number }>();
            return typeof row?.count === "number" ? row.count : 0;
        },
        async updateRoles(uuid, roles) {
            await ensureSchema();
            const rolesJson = serializeRoles(roles);
            const stmt = db.prepare(`
                UPDATE presence
                SET roles = ?
                WHERE uuid = ?
            `);
            await stmt.bind(rolesJson, uuid).run();
        },
    };
}
