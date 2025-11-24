# Shindo Websocket

Servidor HTTP/WebSocket modular responsável por orquestrar presença, autenticação e broadcasting entre o Shindo Client e os serviços auxiliares.

## Visão Geral

- Runtime: Deno (compatível com [Deno Deploy](https://deno.com/deploy)).
- Persistência: Firebase Firestore (API REST via service account).
- Segurança: Rate limiting in-memory, validação com Zod e logs estruturados no stdout.
- Hospedagem alvo: Deno.com (Deploy). Sem dependências nativas ou npm com bindings.

## Estrutura do Projeto

```
src/
  core/               # Bootstrapping, config, logger, cliente Firestore (REST)
  modules/            # Gateway HTTP/WS + presença
index.ts              # Ponto de entrada (bootstrap)
```

## Variáveis de Ambiente

Crie um `.env` baseado em `.env.example` e defina:

```
PORT=8080
WS_PATH=/websocket
ADMIN_KEY=chave-secreta-longa
WS_HEARTBEAT_INTERVAL=30000
OFFLINE_AFTER_MS=120000
FIREBASE_PROJECT_ID=seu-projeto-firebase
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@seu-projeto.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nCHAVE-PRIVADA\n-----END PRIVATE KEY-----\n"
RATE_LIMIT_WINDOW_MS=15000
RATE_LIMIT_MAX=100
```

> **Importante:** mantenha `FIREBASE_PRIVATE_KEY` somente no backend. Use grupos de ambiente/segredos no Deno Deploy para injetar esse valor com segurança.

## Rodando Localmente (Deno)

```
deno run --allow-net --allow-env src/index.ts
```

O servidor usa `Deno.serve` e escuta em `PORT` (padrão `8080`) quando executado fora do Deploy.

## Endpoints

- `GET /v1/health` — healthcheck simples (sem necessidade de autenticação).
- `GET /v1/connected-users` — requer header `x-admin-key`.
- `POST /v1/broadcast` — requer header `x-admin-key`.
- WebSocket em `ws(s)://<host>:<port><WS_PATH>`

## Observabilidade e Segurança

- Logs estruturados no stdout (JSON) pensados para agregação por plataformas de logs do Deno Deploy.
- Rate limiting padrão (100 requisições a cada 15s) aplicado em todas as rotas HTTP.
- Conexões WebSocket não seguras (sem HTTPS/TLS) são rejeitadas automaticamente.
- Payloads inválidos retornam mensagens neutras para evitar vazamento de detalhes sensíveis.

## Próximos Passos

- Implementar camada de plugins para recursos adicionais (banimentos, matchmaking, notificações, etc.).
- Adicionar métricas Prometheus e tracing com OpenTelemetry.
- Integrar pipeline CI para lint, testes e scans de segurança antes do deploy.
