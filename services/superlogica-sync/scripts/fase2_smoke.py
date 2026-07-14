#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FASE 2 — smoke de LEITURA da Superlógica (NÃO escreve no banco).

Dado um id_superlogica:
  1) valida o id (200 real vs 403/null inválido);
  2) lê as unidades paginadas;
  3) monta condomínio + unidades + pessoas em memória, com raw_hash;
  4) imprime o que GRAVARIA (contagens, hashes, amostras não sensíveis).

NÃO grava nada. NÃO imprime PII (nomes de pessoa são redigidos; só contagens,
tipos e hashes). Token vem de ENV (Railway dev), nunca de arquivo.

Uso:
    PYTHONPATH=services/superlogica-sync \\
      python services/superlogica-sync/scripts/fase2_smoke.py [id_superlogica]
    (default id = 164, Quattro Residencial, real)
"""
from __future__ import annotations

import sys
from collections import Counter

from app.montagem import montar_condominio, montar_pessoas, montar_unidade
from app.superlogica import (
    RateLimitError,
    TokenAusenteError,
    ler_condominio,
    ler_unidades,
)
from app.validador import validar_id


def main() -> int:
    cid = sys.argv[1] if len(sys.argv) > 1 else '164'
    print(f'=== FASE 2 SMOKE (só leitura) — id_superlogica={cid} ===\n')

    try:
        # (a) validação do id
        v = validar_id(cid)
        print(f'[validador] id={v["id"]} status={v["status"]} valido={v["valido"]}')
        if not v['valido']:
            print('  -> id NÃO é válido na carteira (ou token sem alcance). '
                  'Sem unidades para montar. Encerrando leitura.')
            return 0

        # leitura do condomínio (já desaninhado)
        status, reg = ler_condominio(cid)
        cond = montar_condominio(reg)
        print(f'\n[condominio] status={status} '
              f'campos={len(cond["campos_disponiveis"])} raw_hash={cond["raw_hash"][:16]}…')
        print(f'  campos disponíveis: {cond["campos_disponiveis"]}')

        # leitura das unidades (paginado, ritmo conservador, para no 429)
        print('\n[unidades] lendo (paginação base 0, lote 50)…')
        cruas = ler_unidades(cid)
        print(f'  unidades lidas: {len(cruas)}')
        if cruas:
            print(f'  campos por unidade: {sorted(cruas[0].keys())}')

        # montagem em memória + hashes
        unidades = []
        pessoas = []
        for u in cruas:
            mu = montar_unidade(u, condominio_id_uuid=None)
            unidades.append(mu)
            pessoas.extend(montar_pessoas(u, unidade_id=mu['id_unidade_uni']))

        tipos = Counter(p['tipo'] for p in pessoas)

        print('\n=== O QUE GRAVARIA (Camada A) — nada foi escrito ===')
        print(f'  condominios : 1 linha (raw_hash {cond["raw_hash"][:16]}…)')
        print(f'  unidades    : {len(unidades)} linhas')
        print(f'  pessoas     : {len(pessoas)} linhas  por tipo: {dict(tipos)}')

        # amostra NÃO sensível (número/bloco da unidade + hash; sem nomes)
        print('\n  amostra de unidades (sem PII):')
        for mu in unidades[:5]:
            print(f'    id={mu["id_unidade_uni"]} '
                  f'unid={mu["st_unidade_uni"]!r} bloco={mu["st_bloco_uni"]!r} '
                  f'raw_hash={mu["raw_hash"][:16]}…')
        if pessoas:
            print('\n  amostra de pessoas (nome REDIGIDO):')
            for p in pessoas[:5]:
                tem_nome = bool(p['nome'])
                print(f'    id_contato={p["id_contato_con"]} tipo={p["tipo"]!r} '
                      f'unidade_id={p["unidade_id"]} nome={"<redacted>" if tem_nome else None} '
                      f'raw_hash={p["raw_hash"][:16]}…')

        print('\n[ok] leitura e montagem concluídas. NENHUMA escrita no banco.')
        return 0

    except TokenAusenteError as e:
        print(f'\n[ERRO] token ausente no ambiente: {e}')
        print('Setar SUPERLOGICA_APP_TOKEN e SUPERLOGICA_ACCESS_TOKEN no Railway dev '
              'e rodar via `railway run`. Não ler de arquivo.')
        return 2
    except RateLimitError as e:
        print(f'\n[STOP] rate limit (429): {e}. Parando, como manda o contrato.')
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
