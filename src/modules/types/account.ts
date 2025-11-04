export const ACCOUNT_TYPES = ["MICROSOFT", "OFFLINE"] as const;
export type AccountType = typeof ACCOUNT_TYPES[number];
