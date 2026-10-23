# -*- coding: utf-8 -*-
"""Leitura dos documentos da apresentação de assembleia (23/10/2026):
  . /v13/imagens/converter: EMF pequeno gerado aqui vira JPEG sem a borda branca; arquivo que
    não é EMF volta recusado sem ir para o LibreOffice; mais de 20 imagens é 422. Se o
    LibreOffice deste ambiente não converter EMF, o teste de conversão é pulado com aviso.
  . /v13/apresentacao/financeiro: dados brutos no formato do Superlógica viram o resumo, que
    fecha no centavo (saldo inicial + receitas menos despesas = saldo final), com a explicação
    do mês negativo e da rubrica fora da rotina; saldo que não bate é 422."""
import base64
import io
import os
import shutil
import struct
import tempfile

import pytest
from PIL import Image

from app import apresentacao_imagens as AI
from app import apresentacao_financeiro as AF


def _emf(w=800, h=500):
    """EMF mínimo: um retângulo e uma elipse cheios (cabeçalho de 88 bytes + 5 registros)."""
    recs = []

    def rec(tipo, corpo):
        recs.append(struct.pack('<II', tipo, 8 + len(corpo)) + corpo)
    rec(39, struct.pack('<IIII', 1, 0, 0x00204080, 0))   # CREATEBRUSHINDIRECT
    rec(37, struct.pack('<I', 1))                         # SELECTOBJECT
    rec(43, struct.pack('<iiii', 100, 100, w - 100, h - 150))  # RECTANGLE
    rec(42, struct.pack('<iiii', 200, h - 120, 400, h - 20))   # ELLIPSE
    rec(14, struct.pack('<III', 0, 16, 20))               # EOF
    corpo = b''.join(recs)
    fr = lambda px: int(px * 2540 / 96)
    hdr = (struct.pack('<II', 1, 88) + struct.pack('<iiii', 0, 0, w - 1, h - 1) + struct.pack('<iiii', 0, 0, fr(w), fr(h))
           + struct.pack('<IIIIHHIII', 0x464D4520, 0x10000, 88 + len(corpo), len(recs) + 1, 2, 0, 0, 0, 0)
           + struct.pack('<ii', 1024, 768) + struct.pack('<ii', 271, 203))
    return hdr + corpo


def _cliente():
    from fastapi.testclient import TestClient
    os.environ.setdefault('INTERNAL_API_SECRET', 'segredo-teste')
    from app import auth
    auth.INTERNAL_API_SECRET = auth.INTERNAL_API_SECRET or 'segredo-teste'
    from app.main import app
    return TestClient(app), {'X-Internal-Secret': auth.INTERNAL_API_SECRET}


def test_assinatura_dos_formatos():
    assert AI.formato_real(_emf()) == 'emf'
    assert AI.formato_real(b'\xd7\xcd\xc6\x9a' + b'\0' * 30) == 'wmf'
    assert AI.formato_real(b'\x89PNG\r\n\x1a\n' + b'\0' * 60) is None


def test_converter_recusa_o_que_nao_e_emf_e_limite():
    png = io.BytesIO()
    Image.new('RGB', (300, 200), 'red').save(png, 'PNG')
    with tempfile.TemporaryDirectory() as tmp:
        r = AI.converter([{'id': 'v1', 'formato': 'emf', 'b64': base64.b64encode(png.getvalue()).decode()}], tmp, soffice='nao-existe')
    assert r == [{'id': 'v1', 'ok': False, 'motivo': 'não é EMF nem WMF'}]
    cli, h = _cliente()
    item = {'id': 'x', 'formato': 'emf', 'b64': base64.b64encode(_emf()).decode()}
    assert cli.post('/v13/imagens/converter', json={'imagens': [item] * 21}, headers=h).status_code == 422
    assert cli.post('/v13/imagens/converter', json={'imagens': [item]}).status_code in (401, 503)


def test_converter_emf_em_jpeg():
    if not shutil.which(os.environ.get('SOFFICE_BIN', 'libreoffice')):
        pytest.skip('AVISO: LibreOffice não instalado neste ambiente; conversão de EMF não testada.')
    cli, h = _cliente()
    resp = cli.post('/v13/imagens/converter', json={'imagens': [{'id': 'v1', 'formato': 'emf', 'b64': base64.b64encode(_emf()).decode()}]}, headers=h)
    assert resp.status_code == 200
    r = resp.json()['imagens'][0]
    if not r['ok']:
        pytest.skip('AVISO: o LibreOffice deste ambiente não converteu EMF (' + r.get('motivo', '') + ').')
    im = Image.open(io.BytesIO(base64.b64decode(r['b64'])))
    assert im.format == 'JPEG'
    # A página A4 inteira teria proporção 0,707; cortada, sobra o desenho (mais largo que alto).
    assert im.width > im.height and max(im.size) <= 1600
    assert (r['largura'], r['altura']) == im.size
    mini = Image.open(io.BytesIO(base64.b64decode(r['b64_mini'])))
    assert max(mini.size) <= 384


# ── Financeiro ──
def _bal(rec, desp):
    linhas = [{'conta': '1', 'descricao': 'RECEITAS', 'valor': round(sum(rec.values()), 2)}]
    for i, (n, v) in enumerate(rec.items(), 1):
        linhas.append({'conta': f'1.{i}', 'descricao': n, 'valor': v, 'itens': []})
    linhas.append({'conta': '2', 'descricao': 'DESPESAS', 'valor': round(sum(sum(r.values()) for r in desp.values()), 2)})
    for ci, (c, rubs) in enumerate(desp.items(), 1):
        linhas.append({'conta': f'2.{ci}', 'descricao': c, 'valor': round(sum(rubs.values()), 2)})
        for ri, (n, v) in enumerate(rubs.items(), 1):
            linhas.append({'conta': f'2.{ci}.{ri}', 'descricao': n, 'valor': v, 'itens': []})
    return [{'itens': [linhas]}]


def _bruto(final_ref=None):
    rec = {'TAXA CONDOMINIAL': 50000.10, 'FUNDO DE RESERVA': 5000.0}
    normal = {'PESSOAL': {'SALARIOS': 30000.0, 'INSS': 2500.33}, 'MANUTENCAO': {'MANUTENCAO ELEVADOR': 2000.0}}
    setembro = {'PESSOAL': {'SALARIOS': 30000.0, 'INSS': 2500.33}, 'MANUTENCAO': {'MANUTENCAO ELEVADOR': 2000.0},
                'BENFEITORIAS': {'OBRA FACHADA': 90000.0}}
    return {
        'condominio': {'id': '136', 'nome': 'Residencial Teste', 'fantasia': 'Residencial Teste'},
        'inicio': '2026-07', 'fim': '2026-09', 'saldo_inicial': 100000.0,
        'saldo_final_ref': final_ref if final_ref is not None else round(100000 + 3 * 55000.10 - 2 * 34500.33 - 124500.33, 2),
        'balancetes': {'2026-07': _bal(rec, normal), '2026-08': _bal(rec, normal), '2026-09': _bal(rec, setembro)},
        'despesas': [], 'contas': None,
    }


def test_resumo_financeiro_fecha_e_explica():
    r = AF.resumo(_bruto())
    c = lambda v: round(v * 100)
    assert c(r['saldo_inicial']) + c(r['receitas']) - c(r['despesas']) == c(r['saldo_final'])
    assert r['rotulo_periodo'] == 'julho a setembro de 2026'
    assert [m['curto'] for m in r['meses']] == ['jul/26', 'ago/26', 'set/26']
    assert r['meses'][2]['resultado'] < 0 and r['meses'][2]['explicacao']
    assert 'fachada' in r['meses'][2]['explicacao'].lower()
    assert r['meses'][0]['explicacao'] == ''
    assert r['resultado'] < 0 and 'déficit' in r['textos']['resumo'].lower()
    assert r['categorias'][0]['nome'] == 'Pessoal' and r['categorias'][0]['rubricas'][1]['nome'] == 'INSS'
    obra = [rb for cat in r['categorias'] for rb in cat['rubricas'] if rb['chave'] == 'OBRA FACHADA'][0]
    assert obra['explicacao'].startswith('Fora da rotina')
    assert r['arrecadacao'][0]['nome'] == 'Taxa condominial'


def test_rota_financeiro_e_saldo_que_nao_bate():
    cli, h = _cliente()
    ok = cli.post('/v13/apresentacao/financeiro', json=_bruto(), headers=h)
    assert ok.status_code == 200 and ok.json()['meses'][1]['saldo_fim'] > 0
    ruim = cli.post('/v13/apresentacao/financeiro', json=_bruto(final_ref=1.0), headers=h)
    assert ruim.status_code == 422 and 'não bate' in ruim.json()['detail']['detalhe']
    assert cli.post('/v13/apresentacao/financeiro', json=_bruto()).status_code in (401, 503)
