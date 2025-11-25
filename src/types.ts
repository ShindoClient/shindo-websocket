export type AccountType = "MICROSOFT" | "OFFLINE";

export type ClientToServer =
    | { type: "auth"; uuid: string; name: string; accountType: AccountType; roles?: string[] }
    | { type: "ping" }
    | { type: "roles.update"; roles: string[] };

export type ServerToClient =
    | { type: "auth.ok"; uuid: string; roles: string[] }   // 👈 inclui roles
    | { type: "user.join"; uuid: string; name: string; accountType: AccountType }
    | { type: "user.leave"; uuid: string }
    | { type: "user.roles"; uuid: string; roles: string[] }
    | { type: "pong" };

export interface ConnectionState {
    uuid: string;
    name: string;
    roles: string[];
    accountType: AccountType;
    lastSeen: number;
    connectedAt: number;
    lastKeepAliveAt: number;
    isAlive: boolean;
}
