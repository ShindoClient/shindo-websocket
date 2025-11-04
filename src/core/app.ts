import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { initFirebase } from "./firebase.js";
import { registerGateway, type Gateway } from "../modules/gateway/gateway.js";
import { registerPlugins } from "../plugins/index.js";

export interface AppContext extends Gateway {
    app: express.Express;
    server: http.Server;
}

export async function bootstrap(): Promise<AppContext> {
    initFirebase();

    const app = express();
    app.set("trust proxy", 1);

    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
    }));
    app.use(cors({
        origin: true,
        credentials: true,
    }));
    app.use(express.json({ limit: "1mb" }));

    const limiter = rateLimit({
        windowMs: config.rateLimit.windowMs,
        limit: config.rateLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
    });
    app.use(limiter);

    const server = http.createServer(app);
    const gateway = registerGateway({ app, server });
    const context: AppContext = { app, server, ...gateway };

    await registerPlugins(context);

    server.listen(config.port, () => {
        logger.info({ port: config.port, path: config.wsPath }, "Gateway listening");
    });

    return context;
}
