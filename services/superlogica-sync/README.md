# superlogica-sync

Serviço de sincronização Superlógica → Supabase do Service Hub. **Só leitura na Superlógica.** Roda como serviço próprio no Railway (projeto `eloquent-love`), separado do `superlogica-proxy` (que é repassador puro).

## Estado

Frente B **implementada e ativa em dev**. Sync completo da Camada A + cron diário agendado (06:00 BRT / `0 9 * * *` UTC). O serviço roda como **cron puro** no Railway: o container executa `python -m app.sync` e morre. Não há HTTP server permanente.

| Fase | Entrega | Status |
|---|---|---|
| 1 | Fundação: migrações Camada A/B + esqueleto | Concluída |
| 2 | Leitura e validação por id (sem escrever no banco) | Concluída |
| 3 | Diff + escrita Camada A (primeira escrita real em dev) | Concluída |
| 4 | Camada B: briefing `.md` determinístico | Pendente |
| 5 | Cron diário em dev | Concluída (implantada junto à Fase 3) |

## Arquitetura

- **Camada A** (estruturado): tabelas `condominios` (aditiva), `unidades`, `pessoas`.
- **Camada B** (briefing): tabela `condominio_contexto` com `.md` + `content_hash` (coluna, não Storage; ZERO IA).
- **Descoberta de ids:** a REST v2 não enumera a carteira por token. O sync **itera os ids já cadastrados no Supabase** e valida cada um.
- **Incremental:** a REST v2 não tem delta. É full read por condomínio + diff por `raw_hash`.

## Endpoints

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/healthz` | nenhuma | status + presença das ENVs (bool, sem valor) |

## Variáveis de ambiente (setadas no Railway dev, nunca em arquivo)

| Var | Uso |
|---|---|
| `SUPERLOGICA_APP_TOKEN` | app_token REST v2 condor |
| `SUPERLOGICA_ACCESS_TOKEN` | access_token REST v2 condor |
| `SUPABASE_URL` | projeto Supabase DEV (`ledgyprytkuvgtbunsck`) |
| `SUPABASE_SERVICE_ROLE_KEY` | escrita server side (bypassa RLS) |
| `INTERNAL_API_SECRET` | segredo compartilhado com o `server.js` do Hub |

O `/healthz` mostra quais estão setadas sem revelar valor.

## Rodar local

```
pip install -r requirements.txt

# Conferir ENVs via healthz (utilitário local; NAO e o modo de producao):
uvicorn app.main:app --reload --port 8000
curl localhost:8000/healthz

# Executar o sync manualmente (equivalente ao que o Railway dispara no cron):
python -m app.sync
```

## Deploy (Railway, env dev)

Serviço novo `superlogica-sync`, root directory `services/superlogica-sync`, Dockerfile. As variáveis são setadas pelo Mateus no Railway dev (o código nunca embute token). `railway environment dev` antes de qualquer `--set`.
