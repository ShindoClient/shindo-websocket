import type { WebSocket } from "ws";
import type { AccountType } from "../types/account.js";
import type { AllowedRole } from "./schema.js";

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
