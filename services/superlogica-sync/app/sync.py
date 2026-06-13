# -*- coding: utf-8 -*-
"""Sync completo da Camada A (entrada do cron diário).

Roda DENTRO do superlogica-sync, que tem os tokens da Superlógica E a
service_role do Supabase dev. Fluxo, num processo só:

  1) lista os condomínios da tabela `condominios` (Supabase);
  2) para cada um, lê a Superlógica (SOMENTE LEITURA) e valida o id;
  3) upsert por raw_hash em `condominios` (no-op se nada mudou).

Regra inviolável: LÊ da Superlógica, ESCREVE no Supabase dev. NUNCA escreve na
Superlógica. Id inválido (403, vazio, null, erro) é pulado e marcado — nunca
derruba o sync. Cada id é isolado em try/except.

Entrada do cron: `python -m app.sync`. Sai com 0 sempre que o lote roda até o
fim (mesmo com inválidos); só sai !=0 se faltar credencial (setup quebrado).
"""
from __future__ import annotations

import datetime as dt
import os
import sys

import httpx

from .hashing import raw_hash
from .superlogica import ler_condominio

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
_BASE = f"{SUPABASE_URL}/rest/v1/condominios"


def _headers() -> dict:
    return {"apikey": SERVICE_ROLE, "Authorization": f"Bearer {SERVICE_ROLE}",
            "Content-Type": "application/json"}


def _v(reg: dict, *nomes: str):
    for n in nomes:
        x = reg.get(n)
        if x not in (None, "", " "):
            return str(x).strip()
    return None


def montar_row(reg: dict, idsl) -> dict:
    """Linha persistível do condomínio. UF de st_uf_uf (sigla 'ES'), nunca
    st_estado_cond (código interno)."""
    endereco = ", ".join(p for p in [
        _v(reg, "st_endereco_cond"), _v(reg, "st_complemento_cond"),
        _v(reg, "st_bairro_cond"), _v(reg, "st_cidade_cond"),
        _v(reg, "st_uf_uf", "st_estado_cond")] if p)
    return {
        "id_superlogica": idsl,
        "nome": _v(reg, "st_nome_cond"),
        "cnpj": _v(reg, "st_cpf_cond"),
        "endereco": endereco or None,
        "raw_hash": raw_hash(reg),
        "mockup": False,
        "proposito_teste": "sync Camada A (superlogica-sync)",
    }


def _listar(client: httpx.Client) -> list:
    r = client.get(_BASE, headers=_headers(),
                   params={"select": "id,nome,id_superlogica", "order": "nome"})
    r.raise_for_status()
    return r.json()


def _upsert(client: httpx.Client, row: dict) -> str:
    idsl = row["id_superlogica"]
    g = client.get(_BASE, headers=_headers(),
                   params={"id_superlogica": f"eq.{idsl}", "select": "id,raw_hash"})
    g.raise_for_status()
    existe = g.json()
    agora = dt.datetime.now(dt.timezone.utc).isoformat()
    if not existe:
        corpo = {k: v for k, v in row.items() if v is not None}
        corpo["synced_at"] = agora
        rr = client.post(_BASE, headers={**_headers(), "Prefer": "return=representation"},
                         json=[corpo])
        return "CRIADO" if rr.status_code in (200, 201) else f"ERRO_{rr.status_code}"
    if existe[0]["raw_hash"] == row["raw_hash"]:
        return "NO-OP"
    patch = {k: v for k, v in row.items() if v is not None}
    patch.update({"synced_at": agora, "updated_at": agora})
    client.patch(_BASE, headers=_headers(),
                 params={"id_superlogica": f"eq.{idsl}"}, json=patch)
    return "ATUALIZADO"


def sincronizar() -> dict:
    if not SUPABASE_URL or not SERVICE_ROLE:
        print("[sync] ERRO: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes "
              "no ambiente do serviço.", file=sys.stderr)
        raise SystemExit(2)

    inicio = dt.datetime.now(dt.timezone.utc).isoformat()
    print(f"[sync] inicio={inicio}")
    sincronizados, pulados = [], []
    with httpx.Client(timeout=30) as client:
        lista = _listar(client)
        print(f"[sync] condominios listados: {len(lista)}")
        for c in lista:
            idsl = c.get("id_superlogica")
            nome = c.get("nome")
            if idsl in (None, ""):
                pulados.append((nome, None, "sem id_superlogica (mockup sem id real)"))
                continue
            try:
                status, reg = ler_condominio(idsl)
                if status == 200 and isinstance(reg, dict) and reg:
                    acao = _upsert(client, montar_row(reg, idsl))
                    sincronizados.append((nome, idsl, acao))
                else:
                    pulados.append((nome, idsl, f"HTTP {status} / sem dados (id invalido)"))
            except Exception as e:  # isola: um id ruim nunca derruba o lote
                pulados.append((nome, idsl, f"erro de leitura: {type(e).__name__}"))

    print("=" * 64)
    print(f"[sync] PROCESSADOS={len(lista)} SINCRONIZADOS={len(sincronizados)} "
          f"PULADOS={len(pulados)}")
    for nome, idsl, acao in sincronizados:
        print(f"  [{acao:10s}] id_sl={idsl} {nome}")
    for nome, idsl, motivo in pulados:
        print(f"  [PULADO    ] id_sl={idsl} {nome} — {motivo}")
    print(f"[sync] fim={dt.datetime.now(dt.timezone.utc).isoformat()}")
    return {"processados": len(lista), "sincronizados": len(sincronizados),
            "pulados": len(pulados)}


def gravar_status(resultado: str, resumo: dict, erro_msg: str | None) -> None:
    """Registra a run em sync_status (base de monitoramento). Defensivo: se a
    tabela ainda não foi criada (migração 011), só avisa — não derruba o sync."""
    if not SUPABASE_URL or not SERVICE_ROLE:
        return
    linha = {
        "resultado": resultado,
        "processados": resumo.get("processados"),
        "sincronizados": resumo.get("sincronizados"),
        "pulados": resumo.get("pulados"),
        "erro_msg": (erro_msg or "")[:500] or None,
    }
    try:
        with httpx.Client(timeout=15) as client:
            r = client.post(f"{SUPABASE_URL}/rest/v1/sync_status",
                            headers=_headers(), json=[linha])
        if r.status_code in (200, 201):
            print(f"[sync] status gravado: resultado={resultado}")
        else:
            print(f"[sync] AVISO: nao gravou status (HTTP {r.status_code}). "
                  f"Tabela sync_status existe? (migracao 011). Corpo: {r.text[:160]}",
                  file=sys.stderr)
    except Exception as e:
        print(f"[sync] AVISO: falha ao gravar status: {type(e).__name__}", file=sys.stderr)


if __name__ == "__main__":
    try:
        resumo = sincronizar()
        gravar_status("ok", resumo, None)
    except SystemExit:
        raise  # credencial ausente: setup quebrado, nem da pra registrar status
    except Exception as e:  # falha no lote: registra erro e propaga (cron marca falha)
        gravar_status("erro", {}, f"{type(e).__name__}: {e}")
        raise
