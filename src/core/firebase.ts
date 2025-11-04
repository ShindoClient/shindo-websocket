import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { config } from "./config.js";
import { logger } from "./logger.js";

let firestoreClient: Firestore | null = null;

function normalizePrivateKey(key: string): string {
    return key.replace(/\\n/g, "\n");
}

export function initFirebase(): Firestore {
    if (firestoreClient) return firestoreClient;

    const { projectId, clientEmail, privateKey } = config.firebase;

    if (!getApps().length) {
        initializeApp({
            credential: cert({
                projectId,
                clientEmail,
                privateKey: normalizePrivateKey(privateKey),
            }),
        });
    }

    firestoreClient = getFirestore();
    logger.info("Firebase admin client initialized");
    return firestoreClient;
}

export function firestore(): Firestore {
    if (!firestoreClient) {
        throw new Error("Firebase not initialized. Call initFirebase() first.");
    }
    return firestoreClient;
}
