import { getConfig } from "../../core/config.ts";
import { logger } from "../../core/logger.ts";
import {
    clientMessageSchema,
    normalizeRoles,
    normalizeAccountType,
    type AllowedRole,
    type ClientMessage,
    type AuthMessage,
    type RolesUpdateMessage,
    type WarpStatusMessage,
} from "./schema.ts";
import { createPresenceClient, type PresenceClient, type PresenceBindings } from "../presence/service.ts";
import type { ConnectionStore, ConnectionState } from "./state.ts";
import { persistWebsocketStartTime, type HealthBindings } from "../health/service.ts";
import type { EnvBindings } from "../../core/config.ts";

export interface Gateway {
    connections: ConnectionStore;
    handleRequest(req: Request, meta: RequestMeta): Promise<Response> | Response;
    broadcast(payload: unknown): void;
}

export interface RequestMeta {
    clientIp: string | null;
}

const DEFAULT_ROLE: AllowedRole = "MEMBER";
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-admin-key, x-forwarded-for, x-forwarded-proto",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
};

type GatewayEnv = EnvBindings & PresenceBindings & HealthBindings;

export function registerGateway(env: GatewayEnv): Gateway {
    const config = getConfig();
    const presence: PresenceClient = createPresenceClient(env);
    const warpKv = env.APP_KV;
    const startTime = Date.now();
    let persistedStartTime = startTime;
    let startTimeReady: Promise<void> | null = null;

    const connections: ConnectionStore = new Map();
    const rateLimitState = new Map<string, { count: number; resetAt: number }>();
    appHeartbeat(connections, config.hbInterval, config.offlineAfter, presence);
    startVerificationLoop(connections, config.verifyIntervalMs, presence);
    startTimeReady = syncStartTime(env, startTime, (value) => {
        persistedStartTime = value;
    });

    function broadcast(payload: unknown) {
        broadcastToAll(connections, payload);
    }

    async function handleRequest(req: Request, meta: RequestMeta): Promise<Response> {
        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(req.url);

        if (url.pathname === config.wsPath && req.headers.get("upgrade") === "websocket") {
            return handleWebSocket(req, meta, connections, presence);
        }

        if (isRateLimited(meta, rateLimitState)) {
            return json({ success: false, message: "Too many requests" }, 429);
        }

        if (url.pathname === "/v1/health" && req.method === "GET") {
            if (startTimeReady) {
                try {
                    await startTimeReady;
                } catch {
                    // Already logged inside syncStartTime
                }
            }
            const effectiveStart = persistedStartTime || startTime;
            const onlineUsers = await presence.countOnlineUsers().catch((error) => {
                logger.warn({ err: error }, "Failed to count online users from presence DO");
                return null;
            });
            const uniqueUsers = new Set(Array.from(connections.values()).map((state) => state.uuid)).size;
            return json({
                ok: true,
                env: config.env,
                version: config.commitHash,
                startedAt: new Date(effectiveStart).toISOString(),
                uptimeMs: Date.now() - effectiveStart,
                timestamp: new Date().toISOString(),
                connections: connections.size,
                onlineUsers: onlineUsers ?? undefined,
                uniqueUsers,
            });
        }

        if (url.pathname === "/v1/connected-users" && req.method === "GET") {
            if (!isAuthorized(req)) {
                return json({ success: false, message: "Unauthorized" }, 401);
            }

            try {
                const usersFromDb = await presence.fetchOnlineUsers(500);
                const users = usersFromDb.map((user) => ({
                    uuid: user.uuid,
                    name: user.name,
                    accountType: user.accountType,
                    lastSeen: normalizeDate(user.last_seen),
                    connectedAt: normalizeDate(user.last_join),
                    roles: user.roles,
                }));
                return json({ success: true, users, connections: users.length });
            } catch (error) {
                logger.error({ err: error }, "Failed to fetch online users from presence DO, falling back to in-memory map");
            }

            const deduped = new Map<string, ConnectionState>();
            for (const state of connections.values()) {
                const current = deduped.get(state.uuid);
                if (!current || current.lastSeen < state.lastSeen) {
                    deduped.set(state.uuid, state);
                }
            }

            const users = Array.from(deduped.values()).map((connection) => ({
                uuid: connection.uuid,
                name: connection.name,
                accountType: connection.accountType,
                lastSeen: connection.lastSeen,
                connectedAt: connection.connectedAt,
                roles: connection.roles,
            }));

            return json({ success: true, users, connections: connections.size });
        }

        if (url.pathname === "/v1/broadcast" && req.method === "POST") {
            if (!isAuthorized(req)) {
                return json({ success: false, message: "Unauthorized" }, 401);
            }

            let body: unknown;
            try {
                body = await req.json();
            } catch {
                return json({ success: false, message: "Invalid JSON body" }, 400);
            }

            const { type, payload } = (body ?? {}) as Record<string, unknown>;
            if (typeof type !== "string" || !type.trim()) {
                return json({ success: false, message: "Missing broadcast type" }, 400);
            }

            broadcastToAll(connections, { type, ...(payload ?? {}) });
            return json({ success: true });
        }

        return new Response("Not found", { status: 404, headers: corsHeaders });
    }

    return { connections, handleRequest, broadcast };
}

function handleWebSocket(
    req: Request,
    meta: RequestMeta,
    connections: ConnectionStore,
    presence: PresenceClient,
): Response {
    const ip = meta.clientIp;

    if (!isSecureRequest(req)) {
        logger.warn({ ip }, "Rejected non-secure WebSocket connection");
        return new Response("Insecure connection", { status: 400 });
    }

    const upgradeHeader = req.headers.get("upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const socket = server;
    socket.accept();
    logger.info({ ip }, "WebSocket connection established");

    socket.addEventListener("message", async (event) => {
        try {
            const parsed = clientMessageSchema.parse(JSON.parse(String(event.data)));
            await handleClientMessage(socket, parsed, connections, presence, warpKv);
            const state = connections.get(socket);
            if (state) {
                state.lastSeen = Date.now();
                state.isAlive = true;
            }
        } catch (error) {
            logger.warn({ err: error, raw: String(event.data) }, "WebSocket message rejected");

            let details: unknown = null;
            const anyErr = error as any;
            if (anyErr && Array.isArray(anyErr.issues)) {
                // ZodError: retornamos as issues para facilitar o debug no client.
                details = anyErr.issues;
            } else if (anyErr && typeof anyErr.message === "string") {
                details = anyErr.message;
            } else {
                details = String(error);
            }

            safeSend(socket, {
                type: "error",
                code: "INVALID_PAYLOAD",
                message: "Invalid message payload",
                details,
            });
        }
    });

    socket.addEventListener("close", async (event) => {
        const state = connections.get(socket);
        await cleanupConnection(socket, state, connections, presence, "client_close");
        logger.info({ ip, code: event.code, reason: event.reason, clean: event.wasClean }, "WebSocket connection closed");
    });

    socket.addEventListener("error", (err) => {
        logger.warn({ err, ip }, "WebSocket error");
    });

    (socket as any).clientIp = ip;
    return new Response(null, { status: 101, webSocket: client });
}

async function handleClientMessage(
    socket: WebSocket,
    message: ClientMessage,
    connections: ConnectionStore,
    presence: PresenceClient,
    warpKv: KVNamespace,
) {
    switch (message.type) {
        case "auth":
            await handleAuth(socket, message, connections, presence);
            break;
        case "ping":
            await handlePing(socket, connections, presence);
            break;
        case "roles.update":
            await handleRolesUpdate(socket, message, connections, presence);
            break;
        case "warp.status":
            await handleWarpStatus(socket, message, connections, warpKv);
            break;
        default:
            logger.info({ type: (message as any).type }, "Unhandled WebSocket message type");
    }
}

async function handleWarpStatus(
    socket: WebSocket,
    message: WarpStatusMessage,
    connections: ConnectionStore,
    warpKv: KVNamespace,
) {
    const state = connections.get(socket);
    if (!state || !state.uuid) {
        return;
    }

    const key = `warp:status:${state.uuid}`;
    const now = Date.now();

    const payload = {
        uuid: state.uuid,
        name: state.name,
        accountType: state.accountType,
        ip: state.ip ?? null,
        enabled: message.enabled ?? null,
        status: message.status ?? null,
        warpMode: message.warpMode ?? null,
        warpLatency: message.warpLatency ?? null,
        sessionStartedAt: message.sessionStartedAt ?? null,
        lookupMs: message.lookupMs ?? null,
        cacheHit: message.cacheHit ?? null,
        error: message.error ?? null,
        resolver: message.resolver ?? null,
        clientTimestamp: message.timestamp ?? null,
        serverTimestamp: now,
    };

    try {
        await warpKv.put(key, JSON.stringify(payload));
    } catch (error) {
        logger.warn({ err: error, uuid: state.uuid }, "Failed to persist warp status to KV");
    }
}

async function handleAuth(
    socket: WebSocket,
    message: AuthMessage,
    connections: ConnectionStore,
    presence: PresenceClient,
) {
    let uuid = (message.uuid || "").trim();
    if (!uuid) {
        uuid = crypto.randomUUID();
    }
    const name = (message.name || "Unknown").trim() || "Unknown";
    const accountType = normalizeAccountType(message.accountType);
    const providedRoles = normalizeRoles(message.roles);
    const ip = (socket as any).clientIp ?? null;

    const previousState = connections.get(socket);

    if (previousState && previousState.uuid && previousState.uuid !== uuid) {
        try {
            await presence.markOffline(previousState.uuid);
        } catch (error) {
            logger.error({ err: error, uuid: previousState.uuid }, "Failed to mark previous session offline");
        }
        broadcastToAll(connections, { type: "user.leave", uuid: previousState.uuid });
    }

    let rolesFromDb: AllowedRole[] | undefined;
    try {
        const fetched = await presence.fetchRoles(uuid);
        if (fetched?.length) {
            rolesFromDb = normalizeRoles(fetched);
        }
    } catch (error) {
        logger.error({ err: error, uuid }, "Failed to fetch roles from presence storage");
    }

    const effectiveRoles = rolesFromDb?.length
        ? rolesFromDb
        : providedRoles.length
            ? providedRoles
            : [DEFAULT_ROLE];

    const state: ConnectionState = {
        socket,
        uuid,
        name,
        roles: effectiveRoles,
        accountType,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        lastKeepAliveAt: Date.now(),
        isAlive: true,
        ip,
    };

    connections.set(socket, state);

    await presence.markOnline({
        uuid,
        name,
        roles: effectiveRoles,
        accountType,
        ip,
    }).catch((error) => {
        logger.error({ err: error, uuid }, "Failed to mark user online");
    });

    safeSend(socket, {
        type: "auth.ok",
        uuid,
        roles: effectiveRoles,
    });
    broadcastToAll(connections, {
        type: "user.join",
        uuid,
        name,
        accountType,
    });
}

async function handlePing(socket: WebSocket, connections: ConnectionStore, presence: PresenceClient) {
    const state = connections.get(socket);
    if (!state) return;

    state.lastSeen = Date.now();
    state.isAlive = true;
    try {
        await presence.updateLastSeen(state.uuid);
    } catch (error) {
        logger.warn({ err: error, uuid: state.uuid }, "Failed to update last seen");
    }
    safeSend(socket, { type: "pong" });
}

async function handleRolesUpdate(
    socket: WebSocket,
    rolesMessage: RolesUpdateMessage,
    connections: ConnectionStore,
    presence: PresenceClient,
) {
    const state = connections.get(socket);
    if (!state) return;

    const normalizedRoles = normalizeRoles(rolesMessage.roles);
    state.roles = normalizedRoles;

    await presence.updateRoles(state.uuid, normalizedRoles).catch((error) => {
        logger.error({ err: error, uuid: state.uuid }, "Failed to persist updated roles");
    });

    broadcastToAll(connections, {
        type: "user.roles",
        uuid: state.uuid,
        roles: normalizedRoles,
    });
}

function safeSend(socket: WebSocket, message: unknown) {
    if (socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify(message));
        } catch (err) {
            logger.warn({ err }, "Failed to send WebSocket message");
        }
    }
}

function broadcastToAll(connections: ConnectionStore, payload: unknown) {
    const message = JSON.stringify(payload);
    for (const socket of connections.keys()) {
        if (socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(message);
            } catch (err) {
                logger.warn({ err }, "Failed to broadcast message");
            }
        }
    }
}

async function cleanupConnection(
    socket: WebSocket,
    state: ConnectionState | undefined,
    connections: ConnectionStore,
    presence: PresenceClient,
    reason: string,
    closeCode?: number,
) {
    if (!state) return;

    connections.delete(socket);
    state.isAlive = false;

    await presence.markOffline(state.uuid).catch((error) => {
        logger.error({ err: error, uuid: state.uuid }, "Failed to mark user offline");
    });

    broadcastToAll(connections, { type: "user.leave", uuid: state.uuid });

    if (closeCode) {
        try {
            socket.close(closeCode, reason || "closing");
        } catch (err) {
            logger.warn({ err, uuid: state.uuid }, "Failed to close WebSocket during cleanup");
        }
    }
}

function syncStartTime(env: HealthBindings, startTime: number, onPersisted: (value: number) => void) {
    return persistWebsocketStartTime(env, startTime)
        .then((persisted) => {
            if (typeof persisted === "number") {
                onPersisted(persisted);
            }
        })
        .catch((error) => {
            logger.warn({ err: error }, "Failed to sync websocket start time");
        });
}

function appHeartbeat(
    connections: ConnectionStore,
    intervalMs: number,
    offlineAfterMs: number,
    presence: PresenceClient,
) {
    // Keep sockets warm for Cloudflare while still enforcing liveness.
    const keepAlivePayload = JSON.stringify({ type: "server.keepalive" });
    // Cloudflare tends to drop idle sockets quickly, so clamp to <=10s regardless of config.
    const tickEveryMs = Math.max(5_000, Math.min(intervalMs, 10_000));
    let ticking = false;

    const tick = async () => {
        if (ticking) return;
        ticking = true;
        try {
            const now = Date.now();
            for (const [socket, state] of connections.entries()) {
                if (socket.readyState !== WebSocket.OPEN) {
                    await cleanupConnection(socket, state, connections, presence, "socket_not_open", 4001);
                    continue;
                }

                const inactiveFor = now - state.lastSeen;
                if (inactiveFor > offlineAfterMs) {
                    await cleanupConnection(socket, state, connections, presence, "inactivity_timeout", 4400);
                    continue;
                }

                if (now - state.lastKeepAliveAt >= tickEveryMs - 250) {
                    try {
                        socket.send(keepAlivePayload);
                        state.lastKeepAliveAt = now;
                    } catch (err) {
                        logger.warn({ err, uuid: state.uuid }, "Failed to send keepalive; closing socket");
                        await cleanupConnection(socket, state, connections, presence, "keepalive_failed", 4401);
                    }
                }
            }
        } finally {
            ticking = false;
        }
    };

    setInterval(() => {
        void tick();
    }, tickEveryMs);
}

/**
 * Verificação periódica “profunda” entre o mapa de conexões em memória,
 * o que está registrado no D1 e o que o cliente realmente está usando.
 *
 * - É disparada a cada `verifyIntervalMs` (configurável via Wrangler).
 * - Se o usuário não existir/estiver offline no D1, a conexão é encerrada.
 * - Se houver divergência de `name` ou `accountType` entre memória e D1,
 *   a conexão também é encerrada.
 * - Para cada cliente válido é enviado um `server.verify`, que o client
 *   pode usar para responder com um `ping` extra ou re-auth se necessário.
 */
function startVerificationLoop(
    connections: ConnectionStore,
    verifyIntervalMs: number,
    presence: PresenceClient,
) {
    if (!Number.isFinite(verifyIntervalMs) || verifyIntervalMs <= 0) {
        return;
    }

    const interval = Math.max(60_000, verifyIntervalMs); // pelo menos 1 minuto

    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            // Buscamos um snapshot dos usuários online no D1.
            const limit = Math.max(100, connections.size || 0);
            const snapshot = await presence.fetchOnlineUsers(limit).catch((error) => {
                logger.warn({ err: error }, "Failed to fetch online users for verification");
                return [];
            });

            const byUuid = new Map(snapshot.map((u) => [u.uuid, u]));

            for (const [socket, state] of connections.entries()) {
                if (socket.readyState !== WebSocket.OPEN) {
                    await cleanupConnection(socket, state, connections, presence, "verification_socket_not_open", 4401);
                    continue;
                }

                const row = byUuid.get(state.uuid);
                if (!row || !row.online) {
                    logger.warn({ uuid: state.uuid }, "Verification failed: user not marked online in D1");
                    await cleanupConnection(socket, state, connections, presence, "verification_d1_offline", 4403);
                    continue;
                }

                if (row.name !== state.name || row.accountType !== state.accountType) {
                    logger.warn(
                        {
                            uuid: state.uuid,
                            memory: { name: state.name, accountType: state.accountType },
                            d1: { name: row.name, accountType: row.accountType },
                        },
                        "Verification failed: identity mismatch between client and D1",
                    );
                    await cleanupConnection(socket, state, connections, presence, "verification_identity_mismatch", 4403);
                    continue;
                }

                // Cliente parece consistente: pedimos uma confirmação extra.
                safeSend(socket, {
                    type: "server.verify",
                    uuid: state.uuid,
                    lastSeen: state.lastSeen,
                });
            }
        } finally {
            running = false;
        }
    };

    setInterval(() => {
        void run();
    }, interval);
}

function isAuthorized(req: Request): boolean {
    const config = getConfig();
    const headerKey = req.headers.get("x-admin-key");
    return typeof headerKey === "string" && headerKey === config.adminKey;
}

function isSecureRequest(req: Request): boolean {
    const protoHeader = req.headers.get("x-forwarded-proto");
    if (protoHeader && protoHeader.toLowerCase() !== "https") {
        return false;
    }
    return true;
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
        },
    });
}

function normalizeDate(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
}

function isRateLimited(
    meta: RequestMeta,
    state: Map<string, { count: number; resetAt: number }>,
): boolean {
    const config = getConfig();
    const addr = meta.clientIp ?? "unknown";
    const now = Date.now();
    const current = state.get(addr);
    if (!current || current.resetAt < now) {
        state.set(addr, { count: 1, resetAt: now + config.rateLimit.windowMs });
        return false;
    }

    if (current.count >= config.rateLimit.max) {
        return true;
    }

    current.count += 1;
    return false;
}
