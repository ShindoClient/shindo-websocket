import type { AccountType } from "../types/account.ts";
import type { AllowedRole } from "./schema.ts";

export interface ConnectionState {
    socket: WebSocket;
    uuid: string;
    name: string;
    roles: AllowedRole[];
    accountType: AccountType;
    lastSeen: number;
    connectedAt: number;
    lastKeepAliveAt: number;
    isAlive: boolean;
    ip: string | null;
    // Contador de keepalives não respondidos (incrementa quando enviamos, zera quando recebemos ping/pong)
    unansweredKeepAlives: number;
}

export type ConnectionStore = Map<WebSocket, ConnectionState>;
