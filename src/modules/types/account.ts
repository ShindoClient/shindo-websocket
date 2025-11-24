export const ACCOUNT_TYPES = ["LOCAL", "MICROSOFT", "OFFLINE"] as const;
export type AccountType = typeof ACCOUNT_TYPES[number];
