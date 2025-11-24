# Shindo Gateway

Servidor HTTP/WebSocket modular responsavel por orquestrar presenca, autenticacao e broadcasting entre o Shindo Client e os servicos auxiliares.

## Visao Geral

- **Runtime**: Node.js 18+, TypeScript, WebSocket (`ws`).
- **Persistencia**: Firebase Firestore para dados de sessao/presenca.
- **Seguranca**: Helmet, rate limiting, validacao com Zod e logs estruturados via Pino.
- **Hospedagem alvo**: Render (compativel com `render.yaml` incluso).

## Estrutura do Projeto

```
src/
  core/               # Bootstrapping, config, logger, cliente Firebase
  modules/
    gateway/          # Rotas HTTP + servidor WebSocket
    presence/         # Operacoes de presenca no Firestore
    types/            # Tipos compartilhados entre modulos
index.ts              # Ponto de entrada (bootstrap)
```

## Variaveis de Ambiente

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

> **Importante:** mantenha `FIREBASE_PRIVATE_KEY` somente no backend. Use grupos de ambiente/segredos no Render (ou equivalente) para injetar esse valor com seguranca.

## Scripts

| Comando      | Descricao                                                               |
| ------------ | ----------------------------------------------------------------------- |
| `pnpm dev`   | Executa o servidor em modo desenvolvimento (ts-node + nodemon).         |
| `pnpm build` | Compila o codigo TypeScript para `dist/`.                               |
| `pnpm start` | Inicia a versao compilada (`node dist/index.js`).                       |

## Fluxo de Autenticacao

1. Cliente abre conexao WSS e envia payload `auth` com UUID, nome, tipo de conta e roles sugeridas.
2. Servidor normaliza o payload, aplica roles canonicas do Firestore quando existirem e responde com `auth.ok`.
3. Eventos subsequentes (`ping`, `roles.update`, etc.) passam por validacao e usam o estado in-memory para manter presenca/roles consistentes.

## Observabilidade e Seguranca

- Logs estruturados com `pino`, prontos para agregacao em plataformas como Logtail, Datadog ou Loki.
- Rate limiting padrao (100 requisicoes a cada 15s) aplicado em todas as rotas HTTP.
- Conexoes WebSocket nao seguras (sem HTTPS/TLS) sao rejeitadas automaticamente.
- Payloads invalidos retornam mensagens neutras para evitar vazamento de detalhes sensiveis.

## Desenvolvimento Local

1. `pnpm install`
2. Configurar `.env`
3. `pnpm dev`

O servidor expoe:

- `GET /v1/health` — healthcheck simples (sem necessidade de autenticacao).
- `GET /v1/connected-users` — requer header `x-admin-key`.
- `POST /v1/broadcast` — requer header `x-admin-key`.
- `POST /v1/session` — requer header `x-session-key` (usado pelo launcher/client para emitir tokens JWT).
- WebSocket em `ws(s)://<host>:<port><WS_PATH>`

## Proximos Passos

- Implementar camada de plugins para recursos adicionais (banimentos, matchmaking, notificacoes, etc.).
- Adicionar metricas Prometheus e tracing com OpenTelemetry.
- Integrar pipeline CI para lint, testes e scans de seguranca antes do deploy.
