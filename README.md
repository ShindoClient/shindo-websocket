# Shindo Websocket

Gateway HTTP/WebSocket para presenca, autenticacao e broadcast usado pelo Shindo Client.

## Visao Geral
- Runtime: Cloudflare Workers (fetch handler + WebSocketPair).
- Persistencia: Firebase Firestore via REST (service account JWT).
- Seguranca: Rate limiting in-memory, validacao Zod e logs JSON.
- Hospedagem alvo: Cloudflare Workers; sem dependencias nativas ou bindings.

## Estrutura do Projeto
```
src/
  core/               # Bootstrapping, config, logger, cliente Firestore (REST)
  modules/            # Gateway HTTP/WS + presenca
index.ts              # Handler principal (fetch + upgrade WS)
```

## Variaveis de Ambiente
Crie um `.dev.vars` (usado pelo Wrangler) a partir de `.env.example`:
```
WS_PATH=/websocket
ADMIN_KEY=chave-secreta-longa
WS_HEARTBEAT_INTERVAL=30000
OFFLINE_AFTER_MS=120000
FIREBASE_PROJECT_ID=seu-projeto-firebase
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@seu-projeto.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nCHAVE-PRIVADA\n-----END PRIVATE KEY-----\n"
RATE_LIMIT_WINDOW_MS=15000
RATE_LIMIT_MAX=100
LOG_LEVEL=debug
```

> Segredos (ex.: `ADMIN_KEY`, `FIREBASE_PRIVATE_KEY`) devem ser definidos com `wrangler secret put <NOME>` antes do deploy.

## Rodando Localmente (Wrangler)
```
pnpm install
pnpm dev
```
O Wrangler faz o bundle e expõe o worker localmente; o valor de `PORT` e outras configuracoes de rede sao ignorados no runtime do Cloudflare.

## Deploy
```
pnpm deploy
```

## Endpoints
- `GET /v1/health` – healthcheck simples (sem auth).
- `GET /v1/connected-users` – requer header `x-admin-key`.
- `POST /v1/broadcast` – requer header `x-admin-key`.
- WebSocket em `wss://<host><WS_PATH>`

## Observabilidade e Seguranca
- Logs estruturados em JSON (stdout/stderr do Worker).
- Rate limiting padrao (100 req a cada 15s) aplicado em todas as rotas HTTP.
- Conexoes WebSocket sem HTTPS sao rejeitadas com 400.
- Payloads invalidos retornam mensagens neutras para evitar vazamento de detalhes.
