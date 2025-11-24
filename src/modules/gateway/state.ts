import type { AccountType } from "../types/account.ts";
import type { AllowedRole } from "./schema.ts";

export interface ConnectionState {
    socket: WebSocket;
    uuid: string;
    name: string;
    roles: AllowedRole[];
    accountType: AccountType;
    lastSeen: number;
    isAlive: boolean;
    ip: string | null;
}

export type ConnectionStore = Map<WebSocket, ConnectionState>;
