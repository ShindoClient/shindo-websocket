import type http from "http";
import express, { type Request, type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { config } from "../../core/config.js";
import { logger } from "../../core/logger.js";
import {
    clientMessageSchema,
    normalizeRoles,
    normalizeAccountType,
    type AllowedRole,
    type ClientMessage,
    type AuthMessage,
    type RolesUpdateMessage,
} from "./schema.js";
import {
    markOnline,
    updateLastSeen,
    markOffline,
    fetchRoles,
} from "../presence/service.js";
import type { ConnectionStore, ConnectionState } from "./state.js";
import { firestore } from "../../core/firebase.js";

export interface Gateway {
    wss: WebSocketServer;
    connections: ConnectionStore;
}

export interface GatewayDependencies {
    app: Express;
    server: http.Server;
}

const DEFAULT_ROLE: AllowedRole = "MEMBER";

export function registerGateway({ app, server }: GatewayDependencies): Gateway {
    const wss = new WebSocketServer({
        server,
        path: config.wsPath,
    });
    const connections: ConnectionStore = new Map();

    app.locals.wss = wss;

    registerHttpRoutes(app, connections, wss);
    registerWebSocketHandlers(wss, connections);
    return { wss, connections };
}

function registerHttpRoutes(app: Express, connections: ConnectionStore, wss: WebSocketServer) {
    app.get("/v1/health", async (_req, res) => {
        res.json({
            ok: true,
            env: config.env,
            version: process.env.COMMIT_HASH || "dev",
            uptimeMs: Math.floor(process.uptime() * 1000),
            timestamp: new Date().toISOString(),
            connections: connections.size,
        });
    });

    app.get("/v1/connected-users", (req: Request, res) => {
        if (!isAuthorized(req)) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const users = Array.from(connections.values()).map((connection) => ({
            uuid: connection.uuid,
            name: connection.name,
            accountType: connection.accountType,
            lastSeen: connection.lastSeen,
            roles: connection.roles,
        }));

        res.json({ success: true, users });
    });

    app.post("/v1/broadcast", express.json({ limit: "256kb" }), (req: Request, res) => {
        if (!isAuthorized(req)) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const { type, payload } = req.body || {};
        if (typeof type !== "string" || !type.trim()) {
            return res.status(400).json({ success: false, message: "Missing broadcast type" });
        }

        broadcastToAll(wss, { type, ...(payload ?? {}) });
        res.json({ success: true });
    });
}

function registerWebSocketHandlers(wss: WebSocketServer, connections: ConnectionStore) {
    wss.on("connection", async (socket, req) => {
        const ip = parseIp(req);
        (socket as any).isAlive = true;
        (socket as any).clientIp = ip;

        if (!isSecureRequest(req)) {
            logger.warn({ ip }, "Rejected non-secure WebSocket connection");
            socket.close(4001, "Insecure connection");
            return;
        }

        logger.info({ ip }, "WebSocket connection established");

        socket.on("pong", () => {
            (socket as any).isAlive = true;
        });

        socket.on("message", async (raw) => {
            try {
                const parsed = clientMessageSchema.parse(JSON.parse(String(raw)));
                await handleClientMessage(socket, parsed, connections, wss);
            } catch (error: any) {
                logger.warn({ err: error, raw: String(raw) }, "WebSocket message rejected");
                safeSend(socket, {
                    type: "error",
                    code: "INVALID_PAYLOAD",
                    message: "Invalid message payload",
                });
            }
        });

        socket.on("close", async () => {
            const state = connections.get(socket);
            if (state) {
                connections.delete(socket);
                try {
                    await markOffline(state.uuid);
                } catch (error) {
                    logger.error({ err: error, uuid: state.uuid }, "Failed to mark user offline on close");
                }
                broadcastToAll(wss, { type: "user.leave", uuid: state.uuid });
            }
            logger.info({ ip }, "WebSocket connection closed");
        });

        socket.on("error", (err) => {
            logger.warn({ err, ip }, "WebSocket error");
        });
    });

    appHeartbeat(wss, connections);
}

async function handleClientMessage(
    socket: WebSocket,
    message: ClientMessage,
    connections: ConnectionStore,
    wss: WebSocketServer,
) {
    switch (message.type) {
        case "auth":
            await handleAuth(socket, message, connections, wss);
            break;
        case "ping":
            await handlePing(socket, connections);
            break;
        case "roles.update":
            await handleRolesUpdate(socket, message, connections, wss);
            break;
        default:
            logger.info({ type: (message as any).type }, "Unhandled WebSocket message type");
    }
}

async function handleAuth(
    socket: WebSocket,
    message: AuthMessage,
    connections: ConnectionStore,
    wss: WebSocketServer,
) {
    let uuid = (message.uuid || "").trim();
    if (!uuid) {
        uuid = uuidv4();
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
        broadcastToAll(wss, { type: "user.leave", uuid: previousState.uuid });
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
    broadcastToAll(wss, {
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
    wss: WebSocketServer,
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

    broadcastToAll(wss, {
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

function broadcastToAll(wss: WebSocketServer, payload: unknown) {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (err) {
                logger.warn({ err }, "Failed to broadcast message");
            }
        }
    }
}

function appHeartbeat(wss: WebSocketServer, connections: ConnectionStore) {
    setInterval(async () => {
        for (const socket of wss.clients) {
            const alive = (socket as any).isAlive;
            if (alive === false) {
                const state = connections.get(socket);
                connections.delete(socket);
                socket.terminate();
                if (state) {
                    try {
                        await markOffline(state.uuid);
                    } catch (error) {
                        logger.error({ err: error, uuid: state.uuid }, "Failed to mark user offline after heartbeat timeout");
                    }
                }
                continue;
            }

            (socket as any).isAlive = false;
            try {
                socket.ping();
            } catch (err) {
                logger.warn({ err }, "Failed to send ping frame");
            }

            const state = connections.get(socket);
            if (state && Date.now() - state.lastSeen > config.offlineAfter) {
                try {
                    await markOffline(state.uuid);
                } catch (error) {
                    logger.error({ err: error, uuid: state.uuid }, "Failed to mark user offline due to inactivity");
                }
            }
        }
    }, config.hbInterval);
}

function parseIp(req: http.IncomingMessage): string | null {
    const header = req.headers["x-forwarded-for"];
    if (Array.isArray(header)) {
        return header[0] ?? null;
    }
    return header ?? req.socket.remoteAddress ?? null;
}

function isAuthorized(req: Request): boolean {
    const headerKey = req.headers["x-admin-key"];
    return typeof headerKey === "string" && headerKey === config.adminKey;
}

function isSecureRequest(req: http.IncomingMessage): boolean {
    const protoHeader = req.headers["x-forwarded-proto"];
    if (protoHeader) {
        const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
        if (proto && proto.toLowerCase() !== "https") {
            return false;
        }
    }
    return true;
}
