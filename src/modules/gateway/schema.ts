import { z } from "zod";
import { ACCOUNT_TYPES, type AccountType } from "../types/account.ts";

export const ALLOWED_ROLES = ["STAFF", "DIAMOND", "GOLD", "MEMBER"] as const;
export type AllowedRole = typeof ALLOWED_ROLES[number];

export const roleSchema = z.string().trim().toUpperCase().refine((role): role is AllowedRole => {
    return (ALLOWED_ROLES as readonly string[]).includes(role);
}, { message: "invalid role" });

export const authMessageSchema = z.object({
    type: z.literal("auth"),
    uuid: z.string().trim().min(1),
    name: z.string().trim().min(1).max(32),
    accountType: z.enum(ACCOUNT_TYPES),
    roles: z.array(roleSchema).max(8).optional(),
});

export const pingMessageSchema = z.object({
    type: z.literal("ping"),
});

export const rolesUpdateSchema = z.object({
    type: z.literal("roles.update"),
    roles: z.array(roleSchema).min(1).max(8),
});

export const warpStatusMessageSchema = z.object({
    type: z.literal("warp.status"),
    enabled: z.boolean().optional(),
    status: z.string().trim().max(32).optional(),
    warpMode: z.string().trim().max(32).optional(),
    warpLatency: z.number().int().nonnegative().optional(),
    sessionStartedAt: z.number().int().nonnegative().optional(),
    lookupMs: z.number().int().nonnegative().optional(),
    cacheHit: z.boolean().optional(),
    error: z.string().trim().max(256).optional(),
    resolver: z.string().trim().max(256).optional(),
    timestamp: z.number().int().nonnegative().optional(),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
    authMessageSchema,
    pingMessageSchema,
    rolesUpdateSchema,
    warpStatusMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type AuthMessage = z.infer<typeof authMessageSchema>;
export type RolesUpdateMessage = z.infer<typeof rolesUpdateSchema>;
export type WarpStatusMessage = z.infer<typeof warpStatusMessageSchema>;

export const serverAuthOkSchema = z.object({
    type: z.literal("auth.ok"),
    uuid: z.string(),
    roles: z.array(z.string()),
});

export type AccountRoles = AllowedRole[];

export function normalizeRoles(input: unknown): AllowedRole[] {
    if (!Array.isArray(input)) return [];
    const normalized = input
        .map((value) => String(value || "").trim().toUpperCase())
        .filter((value): value is AllowedRole => (ALLOWED_ROLES as readonly string[]).includes(value));
    return Array.from(new Set(normalized));
}

export function normalizeAccountType(input: unknown): AccountType {
    const value = String(input || "").trim().toUpperCase();
    return (ACCOUNT_TYPES as readonly string[]).includes(value) ? (value as AccountType) : "LOCAL";
}
