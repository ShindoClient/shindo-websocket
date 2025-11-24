import { config } from "./config.ts";
import { logger } from "./logger.ts";

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${config.firebase.projectId}/databases/(default)/documents`;

interface AccessToken {
    token: string;
    expiresAt: number;
}

let cachedToken: AccessToken | null = null;

function normalizePrivateKey(key: string): string {
    return key.replace(/\\n/g, "\n");
}

async function getAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now + 60_000) {
        return cachedToken.token;
    }

    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = {
        iss: config.firebase.clientEmail,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        exp: Math.floor(now / 1000) + 3600,
        iat: Math.floor(now / 1000),
    };
    const payload = base64UrlEncode(JSON.stringify(claims));
    const unsigned = `${header}.${payload}`;
    const signature = await signWithServiceAccount(unsigned, normalizePrivateKey(config.firebase.privateKey));
    const assertion = `${unsigned}.${signature}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, "Failed to obtain access token");
        throw new Error("Failed to obtain access token");
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    cachedToken = {
        token: data.access_token,
        expiresAt: now + data.expires_in * 1000,
    };
    return data.access_token;
}

async function signWithServiceAccount(input: string, privateKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const pkcs8 = pemToArrayBuffer(privateKey);
    const key = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
        },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input));
    return base64UrlEncode(signature);
}

function base64UrlEncode(data: string | ArrayBuffer): string {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const base64 = btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
    const cleaned = pem
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .replace(/\s+/g, "");
    const binary = atob(cleaned);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        buffer[i] = binary.charCodeAt(i);
    }
    return buffer.buffer;
}

type FirestorePrimitive = string | boolean;

type FirestoreArray = string[];

type FirestoreValue = FirestorePrimitive | FirestoreArray;

function encodeFields(data: Record<string, FirestoreValue>) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
            fields[key] = { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
        } else if (typeof value === "boolean") {
            fields[key] = { booleanValue: value };
        } else {
            fields[key] = { stringValue: value };
        }
    }
    return fields;
}

function decodeFields(fields: Record<string, any>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        if ("stringValue" in value) {
            result[key] = value.stringValue;
        } else if ("booleanValue" in value) {
            result[key] = value.booleanValue;
        } else if ("arrayValue" in value && Array.isArray(value.arrayValue.values)) {
            result[key] = value.arrayValue.values
                .map((entry: any) => entry.stringValue)
                .filter((entry: unknown): entry is string => typeof entry === "string");
        }
    }
    return result;
}

async function patchDocument(collection: string, docId: string, data: Record<string, FirestoreValue>) {
    const token = await getAccessToken();
    const url = new URL(`${FIRESTORE_BASE}/${collection}/${docId}`);
    for (const key of Object.keys(data)) {
        url.searchParams.append("updateMask.fieldPaths", key);
    }

    const response = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: encodeFields(data) }),
    });

    if (!response.ok) {
        const body = await response.text();
        logger.error({ status: response.status, body, collection, docId }, "Failed to patch Firestore document");
        throw new Error("Failed to write Firestore document");
    }
}

async function getDocument(collection: string, docId: string): Promise<Record<string, unknown> | null> {
    const token = await getAccessToken();
    const response = await fetch(`${FIRESTORE_BASE}/${collection}/${docId}`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) return null;

    if (!response.ok) {
        const body = await response.text();
        logger.error({ status: response.status, body, collection, docId }, "Failed to fetch Firestore document");
        throw new Error("Failed to fetch Firestore document");
    }

    const payload = await response.json() as { fields?: Record<string, any> };
    if (!payload.fields) return null;
    return decodeFields(payload.fields);
}

class FirestoreDocumentReference {
    constructor(private collection: string, private id: string) {}

    async set(data: Record<string, FirestoreValue>, options?: { merge?: boolean }) {
        // We always merge by specifying an updateMask to avoid overwriting other fields.
        void options;
        await patchDocument(this.collection, this.id, data);
    }

    async get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }> {
        const document = await getDocument(this.collection, this.id);
        return {
            exists: document !== null,
            data: () => document ?? undefined,
        };
    }
}

class FirestoreCollectionReference {
    constructor(private name: string) {}

    doc(id: string) {
        return new FirestoreDocumentReference(this.name, id);
    }
}

class FirestoreClient {
    collection(name: string) {
        return new FirestoreCollectionReference(name);
    }
}

let firestoreClient: FirestoreClient | null = null;

export function initFirebase(): FirestoreClient {
    if (firestoreClient) return firestoreClient;
    firestoreClient = new FirestoreClient();
    logger.info("Firestore REST client initialized");
    return firestoreClient;
}

export function firestore(): FirestoreClient {
    if (!firestoreClient) {
        throw new Error("Firebase not initialized. Call initFirebase() first.");
    }
    return firestoreClient;
}
