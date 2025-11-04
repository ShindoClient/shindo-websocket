import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomUUID } from "node:crypto";
import { config } from "../../core/config.js";
import { logger } from "../../core/logger.js";
import { normalizeRoles, type AllowedRole } from "../gateway/schema.js";
import type { AccountType } from "../types/account.js";
import { fetchRoles } from "../presence/service.js";

const encoder = new TextEncoder();
const secretKey = encoder.encode(config.auth.sessionSecret);

const revokedSessions = new Set<string>();

export interface SessionIdentity {
    uuid: string;
    name: string;
    accountType: AccountType;
    rolesHint?: string[];
}

export interface SessionToken {
    token: string;
    sessionId: string;
    expiresAt: number;
    roles: AllowedRole[];
}

interface TokenPayload extends JWTPayload {
    uuid: string;
    name: string;
    accountType: AccountType;
    roles: AllowedRole[];
    sessionId: string;
}

export type SessionVerification =
    | {
        ok: true;
        data: {
            uuid: string;
            name: string;
            accountType: AccountType;
            roles: AllowedRole[];
            sessionId: string;
            expiresAt?: number;
        };
    }
    | {
        ok: false;
        reason: "revoked" | "invalid";
    };

export async function issueSessionToken(identity: SessionIdentity): Promise<SessionToken> {
    const sessionId = randomUUID();
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + config.auth.sessionTtlSeconds;

    const canonicalRoles = await resolveCanonicalRoles(identity.uuid, identity.rolesHint);

    const payload: TokenPayload = {
        uuid: identity.uuid,
        name: identity.name,
        accountType: identity.accountType,
        roles: canonicalRoles,
        sessionId,
    };

    const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(expiresAtSeconds)
        .sign(secretKey);

    return {
        token,
        sessionId,
        expiresAt: expiresAtSeconds * 1000,
        roles: canonicalRoles,
    };
}

export async function verifySessionToken(token: string): Promise<SessionVerification> {
    try {
        const { payload } = await jwtVerify<TokenPayload>(token, secretKey, {
            algorithms: ["HS256"],
        });

        if (!payload.sessionId || revokedSessions.has(payload.sessionId)) {
            return { ok: false as const, reason: "revoked" };
        }

        return {
            ok: true as const,
            data: {
                uuid: payload.uuid,
                name: payload.name,
                accountType: payload.accountType,
                roles: normalizeRoles(payload.roles),
                sessionId: payload.sessionId,
                expiresAt: payload.exp ? payload.exp * 1000 : undefined,
            },
        };
    } catch (error) {
        logger.warn({ err: error }, "Failed to verify session token");
        return { ok: false as const, reason: "invalid" };
    }
}

export function revokeSession(sessionId: string) {
    if (sessionId) {
        revokedSessions.add(sessionId);
    }
}

async function resolveCanonicalRoles(uuid: string, hint?: string[]) {
    try {
        const fromDb = await fetchRoles(uuid);
        if (fromDb && fromDb.length) {
            return normalizeRoles(fromDb);
        }
    } catch (error) {
        logger.warn({ err: error, uuid }, "Failed to fetch canonical roles from Firestore");
    }
    return normalizeRoles(hint ?? []);
}
