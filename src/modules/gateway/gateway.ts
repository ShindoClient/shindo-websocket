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
} from "./schema.ts";
import {
    markOnline,
    updateLastSeen,
    markOffline,
    fetchRoles,
} from "../presence/service.ts";
import type { ConnectionStore, ConnectionState } from "./state.ts";
import { firestore } from "../../core/firebase.ts";
import { persistWebsocketStartTime } from "../health/service.ts";

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

export function registerGateway(): Gateway {
    const config = getConfig();
    const startTime = Date.now();
    let persistedStartTime = startTime;
    let startTimeReady: Promise<void> | null = null;

    const connections: ConnectionStore = new Map();
    const rateLimitState = new Map<string, { count: number; resetAt: number }>();
    appHeartbeat(connections, config.hbInterval, config.offlineAfter);
    startTimeReady = syncStartTime(startTime, (value) => {
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
            return handleWebSocket(req, meta, connections);
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
            return json({
                ok: true,
                env: config.env,
                version: config.commitHash,
                startedAt: new Date(effectiveStart).toISOString(),
                uptimeMs: Date.now() - effectiveStart,
                timestamp: new Date().toISOString(),
                connections: connections.size,
            });
        }

        if (url.pathname === "/v1/connected-users" && req.method === "GET") {
            if (!isAuthorized(req)) {
                return json({ success: false, message: "Unauthorized" }, 401);
            }

            const users = Array.from(connections.values()).map((connection) => ({
                uuid: connection.uuid,
                name: connection.name,
                accountType: connection.accountType,
                lastSeen: connection.lastSeen,
                roles: connection.roles,
            }));

            return json({ success: true, users });
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

function handleWebSocket(req: Request, meta: RequestMeta, connections: ConnectionStore): Response {
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
            await handleClientMessage(socket, parsed, connections);
            const state = connections.get(socket);
            if (state) state.lastSeen = Date.now();
        } catch (error) {
            logger.warn({ err: error, raw: String(event.data) }, "WebSocket message rejected");
            safeSend(socket, {
                type: "error",
                code: "INVALID_PAYLOAD",
                message: "Invalid message payload",
            });
        }
    });

    socket.addEventListener("close", async () => {
        const state = connections.get(socket);
        if (state) {
            connections.delete(socket);
            try {
                await markOffline(state.uuid);
            } catch (error) {
                logger.error({ err: error, uuid: state.uuid }, "Failed to mark user offline on close");
            }
            broadcastToAll(connections, { type: "user.leave", uuid: state.uuid });
        }
        logger.info({ ip }, "WebSocket connection closed");
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
) {
    switch (message.type) {
        case "auth":
            await handleAuth(socket, message, connections);
            break;
        case "ping":
            await handlePing(socket, connections);
            break;
        case "roles.update":
            await handleRolesUpdate(socket, message, connections);
            break;
        default:
            logger.info({ type: (message as any).type }, "Unhandled WebSocket message type");
    }
}

async function handleAuth(
    socket: WebSocket,
    message: AuthMessage,
    connections: ConnectionStore,
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
            await markOffline(previousState.uuid);
        } catch (error) {
            logger.error({ err: error, uuid: previousState.uuid }, "Failed to mark previous session offline");
        }
        broadcastToAll(connections, { type: "user.leave", uuid: previousState.uuid });
    }

    let rolesFromDb: AllowedRole[] | undefined;
    try {
        const fetched = await fetchRoles(uuid);
        if (fetched?.length) {
            rolesFromDb = normalizeRoles(fetched);
        }
    } catch (error) {
        logger.error({ err: error, uuid }, "Failed to fetch roles from Firestore");
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
        lastSeen: Date.now(),
        isAlive: true,
        ip,
    };

    connections.set(socket, state);

    try {
        await markOnline(
            {
                uuid,
                name,
                roles: effectiveRoles,
                accountType,
            },
            rolesFromDb?.length ? undefined : effectiveRoles,
        );
    } catch (error) {
        logger.error({ err: error, uuid }, "Failed to mark user online");
    }

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

async function handlePing(socket: WebSocket, connections: ConnectionStore) {
    const state = connections.get(socket);
    if (!state) return;

    state.lastSeen = Date.now();
    try {
        await updateLastSeen(state.uuid);
    } catch (error) {
        logger.warn({ err: error, uuid: state.uuid }, "Failed to update last seen");
    }
    safeSend(socket, { type: "pong" });
}

async function handleRolesUpdate(
    socket: WebSocket,
    rolesMessage: RolesUpdateMessage,
    connections: ConnectionStore,
) {
    const state = connections.get(socket);
    if (!state) return;

    const normalizedRoles = normalizeRoles(rolesMessage.roles);
    state.roles = normalizedRoles;

    try {
        const client = firestore();
        await client
            .collection("users")
            .doc(state.uuid)
            .set({ roles: normalizedRoles }, { merge: true });
    } catch (error) {
        logger.error({ err: error, uuid: state.uuid }, "Failed to persist updated roles");
    }

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

function syncStartTime(startTime: number, onPersisted: (value: number) => void) {
    return persistWebsocketStartTime(startTime)
        .then((persisted) => {
            if (typeof persisted === "number") {
                onPersisted(persisted);
            }
        })
        .catch((error) => {
            logger.warn({ err: error }, "Failed to sync websocket start time");
        });
}

function appHeartbeat(connections: ConnectionStore, intervalMs: number, offlineAfterMs: number) {
    setInterval(async () => {
        for (const [socket, state] of connections.entries()) {
            const inactiveFor = Date.now() - state.lastSeen;
            if (inactiveFor > offlineAfterMs) {
                connections.delete(socket);
                try {
                    await markOffline(state.uuid);
                } catch (error) {
                    logger.error({ err: error, uuid: state.uuid }, "Failed to mark user offline due to inactivity");
                }
                broadcastToAll(connections, { type: "user.leave", uuid: state.uuid });
                try {
                    socket.close(4000, "Heartbeat timeout");
                } catch (err) {
                    logger.warn({ err }, "Failed to close stale WebSocket");
                }
            }
        }
    }, intervalMs);
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
