# -*- coding: utf-8 -*-
"""Motor de layouts da apresentação de assembleia: um roteiro com todos os tipos de
slide, fotos geradas com Pillow e um PDF gerado na hora. Confere PPTX e PDF válidos,
número de slides, avisos (tipo desconhecido, foto inexistente, avisos do roteiro),
paginação de tabela e texto longos, logo do cliente e a rota HTTP."""
import base64
import io
import os
import re
import subprocess
import tempfile

import pytest
from PIL import Image, ImageDraw
from pptx import Presentation

from app import apresentacao as A


def _foto(cor=(60, 140, 90), w=1200, h=800):
    im = Image.new('RGB', (w, h), cor)
    ImageDraw.Draw(im).ellipse([w // 4, h // 4, w // 2, h // 2], fill=(230, 200, 60))
    buf = io.BytesIO()
    im.save(buf, 'JPEG')
    return buf.getvalue()


def _png_transparente():
    im = Image.new('RGBA', (600, 400), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle([100, 100, 500, 300], fill=(20, 20, 20, 255))
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


def _pdf(paginas=2):
    imgs = []
    for p in range(paginas):
        im = Image.new('RGB', (1240, 1754), 'white')
        d = ImageDraw.Draw(im)
        for i in range(30):
            d.text((120, 150 + i * 30), f'Linha {i} da pagina {p + 1}', fill='black')
        imgs.append(im)
    buf = io.BytesIO()
    imgs[0].save(buf, 'PDF', save_all=True, append_images=imgs[1:])
    return buf.getvalue()


def _logo():
    im = Image.new('RGB', (800, 300), 'white')
    d = ImageDraw.Draw(im)
    d.ellipse([20, 20, 280, 280], fill=(20, 110, 70))
    d.rectangle([320, 100, 760, 200], fill=(200, 150, 30))
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


LONGO = ('O condomínio recebeu a notificação da prefeitura sobre a calçada. ' * 30).strip()

ROTEIRO = {
    'titulo_arquivo': 'AGE teste',
    'avisos': ['A análise da diretoria diverge do demonstrativo em setembro.'],
    'slides': [
        {'tipo': 'capa', 'assembleia': 'Assembleia Geral Extraordinária', 'sigla': 'AGE',
         'condominio': 'Condomínio Teste Clube', 'data': '16 de outubro de 2024',
         'chamadas': ['1ª chamada às 19h', '2ª chamada às 19h30'], 'local': 'Salão de festas'},
        {'tipo': 'orientacoes', 'blocos': [{'titulo': 'Quórum', 'topicos': ['Metade dos condôminos']},
                                           {'titulo': 'Procuração', 'topicos': ['Uma por condômino']}]},
        {'tipo': 'pauta', 'itens': [{'titulo': 'Reforma do parquinho', 'etiqueta': 'VOTAÇÃO'},
                                    'Pintura das garagens', 'Regimento interno', 'Eleição do conselho']},
        {'tipo': 'item', 'numero': 1, 'titulo': 'Reforma do parquinho', 'subtitulo': 'Piso e brinquedos',
         'etiqueta': 'VOTAÇÃO', 'apresentador': 'Síndica', 'fonte': ['edital, página 1']},
        {'tipo': 'texto', 'numero': 1, 'titulo': 'Contexto', 'paragrafos': ['Texto curto.'], 'destaque': 'Frase em destaque.'},
        {'tipo': 'texto', 'numero': 1, 'titulo': 'Texto longo', 'paragrafos': [LONGO, LONGO]},
        {'tipo': 'topicos', 'numero': 1, 'titulo': 'Situação', 'topicos': ['Um', 'Dois', 'Três']},
        {'tipo': 'colunas', 'numero': 1, 'titulo': 'Opções', 'colunas': [{'nome': 'A', 'topicos': ['x']}, {'nome': 'B', 'topicos': ['y']}]},
        {'tipo': 'orcamento', 'numero': 1, 'titulo': 'Orçamento', 'fornecedor': 'Fornecedor A',
         'itens': [{'descricao': 'Piso', 'valor': 1000.0}, {'descricao': 'Mesa', 'valor': 500.0}], 'total': 1500.0,
         'pagamento': 'À vista', 'prazo': '30 dias'},
        {'tipo': 'orcamento', 'numero': 1, 'titulo': 'Orçamento B', 'fornecedor': 'Fornecedor B',
         'mao_de_obra': 34605.0, 'materiais': 9292.45, 'total': 43897.45, 'documento': 'd1', 'pagina': 1},
        {'tipo': 'comparativo', 'numero': 1, 'titulo': 'Comparativo', 'mostrar_media': True,
         'opcoes': [{'nome': 'A', 'valor': 1500.0}, {'nome': 'B', 'valor': 1800.0}, {'nome': 'C', 'valor': 1700.0},
                    {'nome': 'D', 'valor': 2000.0}, {'nome': 'E', 'valor': 1900.0}]},
        {'tipo': 'tabela', 'numero': 1, 'titulo': 'Tabela longa', 'colunas': ['Serviço', 'Valor'],
         'linhas': [[f'Serviço {i}', f'R$ {i}.000,00'] for i in range(1, 26)], 'total': ['Total', 'R$ 325.000,00']},
        {'tipo': 'numeros', 'numero': 1, 'titulo': 'Saldos', 'cards': [{'rotulo': 'Conta', 'valor': 'R$ 1.000,00'}, {'rotulo': 'Fundo', 'valor': 2500.5}]},
        {'tipo': 'barras', 'numero': 1, 'titulo': 'Despesas', 'mostrar_percentual': True,
         'itens': [{'nome': 'Pessoal', 'valor': 800.0}, {'nome': 'Água', 'valor': 200.0}, {'nome': 'Estorno', 'valor': -50.0}]},
        {'tipo': 'cards', 'numero': 1, 'titulo': 'Frentes', 'cards': [{'titulo': 'Queijaria', 'texto': 'Ajustes', 'status': 'EM ADEQUAÇÃO'},
                                                                     {'titulo': 'Cestas', 'texto': 'Entregues', 'status': 'ENTREGUE'}]},
        {'tipo': 'passos', 'numero': 1, 'titulo': 'Etapas', 'passos': [{'titulo': 'Limpeza', 'texto': 'Retirada'}, {'titulo': 'Obra', 'texto': 'Execução'}]},
        {'tipo': 'pontos', 'numero': 1, 'titulo': 'Pontos', 'pontos': [{'texto': 'Cercamento', 'origem': 'Item 2'}]},
        {'tipo': 'fotos', 'numero': 1, 'titulo': 'Fotos', 'fotos': [{'id': 'f1', 'legenda': 'Uma'}, {'id': 'f2'}, {'id': 'f9'}]},
        {'tipo': 'foto_texto', 'numero': 1, 'titulo': 'Brinquedo', 'foto': 'f3', 'topicos': ['Balanço'], 'valor': 'R$ 4.615,60'},
        {'tipo': 'antes_depois', 'numero': 1, 'titulo': 'Salão', 'antes': 'f1', 'depois': 'f2', 'topicos': ['Piso novo']},
        {'tipo': 'documento', 'numero': 1, 'titulo': 'Projeto', 'documento': 'd1', 'paginas': [1, 2, 7]},
        {'tipo': 'regimento', 'numero': 2, 'titulo': 'Capítulo I', 'artigo': 'Art. 1', 'texto_atual': None, 'proposta': 'Novo texto.'},
        {'tipo': 'custeio', 'numero': 2, 'titulo': 'Custeio', 'valor_total': 21000.0, 'unidades': 440,
         'opcoes': [{'nome': 'Opção 1', 'parcelas': 1, 'valor_parcela': 47.73}]},
        {'tipo': 'votacao', 'numero': 2, 'titulo': 'Votação', 'pergunta': 'Aprovar?', 'regra': 'Maioria simples.'},
        {'tipo': 'eleicao', 'numero': 3, 'titulo': 'Eleição', 'cargos': [{'cargo': 'Síndico', 'mandato': '2025 a 2026'}]},
        {'tipo': 'linha_do_tempo', 'numero': 3, 'titulo': 'Processo', 'eventos': [{'data': '01/01/2024', 'titulo': 'Início'},
                                                                                 {'data': '02/02/2024', 'titulo': 'Fim', 'texto': 'Acordo.'}]},
        {'tipo': 'desconhecido', 'titulo': 'teste'},
        {'tipo': 'encerramento'},
    ],
}
FOTOS = {'f1': _foto(), 'f2': _foto((150, 80, 60), 800, 1200), 'f3': _png_transparente()}
DOCS = {'d1': _pdf(2)}


@pytest.fixture(scope='module')
def gerado():
    with tempfile.TemporaryDirectory() as tmp:
        pptx, pdf, avisos, n = A.montar(ROTEIRO, FOTOS, DOCS, tmp, _logo())
    return pptx, pdf, avisos, n


def _textos(pptx):
    prs = Presentation(io.BytesIO(pptx))
    # R$ e o valor vão com espaço não separável no slide; aqui volta a espaço comum.
    return prs, [' '.join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame).replace('\u00a0', ' ') for s in prs.slides]


def test_pptx_e_pdf_validos(gerado):
    pptx, pdf, _, n = gerado
    assert pdf[:4] == b'%PDF'
    prs, _ = _textos(pptx)
    assert len(prs.slides) == n
    with tempfile.NamedTemporaryFile(suffix='.pdf') as f:
        f.write(pdf)
        f.flush()
        info = subprocess.run(['pdfinfo', f.name], capture_output=True, text=True).stdout
    assert int(re.search(r'Pages:\s+(\d+)', info).group(1)) == n


def test_todos_os_tipos_desenhados(gerado):
    pptx, _, avisos, n = gerado
    _, textos = _textos(pptx)
    tudo = '\n'.join(textos)
    for trecho in ('AGE', 'ORIENTAÇÕES DO EDITAL', 'Pauta da', 'ITEM 1 DE 4', 'Frase em destaque', 'MÃO DE OBRA',
                   'MENOR VALOR', 'MÉDIA DOS 5 ORÇAMENTOS', 'R$ 2.500,50', 'EM ADEQUAÇÃO', 'PONTO 1', 'ANTES', 'DEPOIS',
                   'PÁGINA DO DOCUMENTO', 'Texto inexistente hoje', 'POR UNIDADE', 'R$ 47,73', 'O QUE SERÁ VOTADO',
                   'REGRA DE VOTAÇÃO', 'CARGO EM ELEIÇÃO', '01/01/2024', 'Agradecemos a presença de todos!'):
        assert trecho in tudo, trecho
    # rodapé com condomínio e data e numeração em todos os slides de conteúdo
    assert 'Grupo Service  ·  Condomínio Teste Clube  ·  16 de outubro de 2024' in textos[1]
    assert f'16 de outubro de 2024 {n} ' in textos[-1]   # numeração no rodapé do último slide
    # nada de "fonte" do roteiro no slide
    assert 'edital, página 1' not in tudo


def test_avisos(gerado):
    _, _, avisos, _ = gerado
    junto = '\n'.join(avisos)
    assert avisos[0].startswith('Roteiro: A análise da diretoria')
    assert 'tipo "desconhecido" não existe' in junto
    assert 'foto "f9" não foi enviada' in junto
    assert 'página 7 não existe' in junto


def test_paginacao_tabela_e_texto(gerado):
    pptx, _, _, _ = gerado
    _, textos = _textos(pptx)
    tab = [t for t in textos if 'Tabela longa' in t]
    assert len(tab) == 2                       # 25 linhas, até 15 por slide: 13 e 12
    assert all('(continuação)' in t for t in tab[1:])
    assert 'Serviço 25' in tab[-1] and 'TOTAL' in tab[-1]
    txt = [t for t in textos if 'Texto longo' in t]
    assert len(txt) >= 2 and '(continuação)' in txt[1]


def test_sem_hifen_de_pontuacao():
    with tempfile.TemporaryDirectory() as tmp:
        r = {'slides': [{'tipo': 'capa', 'condominio': 'Cond X', 'data': '01/01/2025'},
                        {'tipo': 'topicos', 'titulo': 'Itens - gerais', 'topicos': ['Portão — quebrado', 'CNPJ 12.345.678/0001-90']}]}
        prs, _ = A.desenhar(r, {}, {}, tmp)
    tudo = ' '.join(sh.text_frame.text for s in prs.slides for sh in s.shapes if sh.has_text_frame)
    assert ' - ' not in tudo and '—' not in tudo
    assert 'Portão, quebrado' in tudo and '0001-90' in tudo


def test_roteiro_ruim_nao_quebra():
    with tempfile.TemporaryDirectory() as tmp:
        r = {'slides': [None, {'tipo': 'orcamento'}, {'tipo': 'comparativo', 'opcoes': 'x'}, {'tipo': 'tabela', 'linhas': [[1, None]]},
                        {'tipo': 'custeio', 'valor_total': 'abc'}, {'tipo': 'fotos', 'fotos': [{'id': 'nada'}]}, {'tipo': 'encerramento'}]}
        prs, avisos = A.desenhar(r, {}, {}, tmp)
    assert len(prs.slides) >= 2
    assert any('não tem capa' in a for a in avisos)
    with tempfile.TemporaryDirectory() as tmp:
        with pytest.raises(A.ErroPrestacao):
            A.desenhar({'slides': []}, {}, {}, tmp)


# ── modo atualizar: apresentação autossuficiente ──

def test_roteiro_embutido_e_recuperado(gerado):
    pptx, _, _, _ = gerado
    r = A.ler(pptx)
    esperado = {k: v for k, v in ROTEIRO.items() if k != 'avisos'}
    assert r['roteiro'] == esperado
    assert r['alterada'] is False
    # logo original, byte a byte
    assert base64.b64decode(r['logo_cliente_b64']) == _logo()
    # o pacote continua abrindo e com a parte de dados ligada à apresentação
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(pptx))
    assert 'customXml/item1.xml' in z.namelist() and 'customXml/itemProps1.xml' in z.namelist()
    assert b'relationships/customXml' in z.read('ppt/_rels/presentation.xml.rels')


def test_imagens_recuperadas_pelo_nome(gerado):
    pptx, _, _, _ = gerado
    prs = Presentation(io.BytesIO(pptx))
    nomes = {sh.name for s in prs.slides for sh in s.shapes}
    assert {'foto:f1', 'foto:f2', 'foto:f3', 'doc:d1:p1', 'doc:d1:p2', 'logo_cliente'} <= nomes
    r = A.ler(pptx)
    fotos = {f['id']: f for f in r['fotos']}
    assert set(fotos) == {'f1', 'f2', 'f3'}
    # foto recortada no slide continua inteira no arquivo (recorte pela moldura)
    im = Image.open(io.BytesIO(base64.b64decode(fotos['f2']['b64'])))
    assert im.size == (800, 1200)
    assert fotos['f3']['grafico'] is True and fotos['f1']['grafico'] is False
    pags = [(p['id'], p['pagina'], p['total']) for p in r['documentos_paginas']]
    assert pags == [('d1', 1, 2), ('d1', 2, 2)]


def test_pptx_editado_a_mao_e_avisado(gerado):
    pptx, _, _, _ = gerado
    prs = Presentation(io.BytesIO(pptx))
    for sh in prs.slides[0].shapes:
        if sh.has_text_frame and sh.text_frame.text.strip():
            sh.text_frame.paragraphs[0].runs[0].text = 'mudado à mão'
            break
    buf = io.BytesIO()
    prs.save(buf)
    r = A.ler(buf.getvalue())       # o PowerPoint salvando de novo mantém a parte de dados
    assert r['alterada'] is True and r['roteiro']['slides'][0]['tipo'] == 'capa'


def test_pptx_sem_roteiro():
    with pytest.raises(A.SemRoteiro):
        A.ler(b'isto nao e um pptx')
    buf = io.BytesIO()
    Presentation().save(buf)
    with pytest.raises(A.SemRoteiro):
        A.ler(buf.getvalue())


def test_render_a_partir_da_imagem_da_pagina(gerado):
    """Sem o PDF: slides "documento" e "orcamento" com página saem da imagem já pronta."""
    pptx, _, _, _ = gerado
    r = A.ler(pptx)
    paginas = {}
    for p in r['documentos_paginas']:
        d = paginas.setdefault(p['id'], {'total': p['total'], 'paginas': {}})
        d['paginas'][p['pagina']] = base64.b64decode(p['b64'])
    fotos = {f['id']: base64.b64decode(f['b64']) for f in r['fotos']}
    graficos = {f['id']: f['grafico'] for f in r['fotos'] if 'grafico' in f}
    rot = {'slides': [{'tipo': 'capa', 'condominio': 'Cond', 'data': 'hoje'},
                      {'tipo': 'documento', 'titulo': 'Projeto', 'documento': 'd1', 'paginas': [2, 3]},
                      {'tipo': 'orcamento', 'titulo': 'Orçamento B', 'fornecedor': 'B', 'total': 10.0, 'documento': 'd1', 'pagina': 1},
                      {'tipo': 'foto_texto', 'titulo': 'Brinquedo', 'foto': 'f3', 'topicos': ['Balanço']}]}
    with tempfile.TemporaryDirectory() as tmp:
        pptx2, pdf2, avisos, n = A.montar(rot, fotos, {}, tmp, None, paginas, graficos)
    assert pdf2[:4] == b'%PDF' and n == 4
    _, textos = _textos(pptx2)
    assert 'PÁGINA DO DOCUMENTO' in textos[1] and '2 de 2' in textos[1]   # total original do documento
    assert any('página 3 não existe' in a for a in avisos)
    # a página reaproveitada continua rastreável na apresentação nova
    r2 = A.ler(pptx2)
    assert [(p['id'], p['pagina'], p['total']) for p in r2['documentos_paginas']] == [('d1', 1, 2), ('d1', 2, 2)]
    assert base64.b64decode(r2['documentos_paginas'][1]['b64']) == paginas['d1']['paginas'][2]
    assert [f['grafico'] for f in r2['fotos'] if f['id'] == 'f3'] == [True]


def _cliente():
    from fastapi.testclient import TestClient
    os.environ.setdefault('INTERNAL_API_SECRET', 'segredo-teste')
    from app import auth
    auth.INTERNAL_API_SECRET = auth.INTERNAL_API_SECRET or 'segredo-teste'
    from app.main import app
    return TestClient(app), {'X-Internal-Secret': auth.INTERNAL_API_SECRET}


def test_rota_ler(gerado):
    cli, h = _cliente()
    pptx, _, _, _ = gerado
    r = cli.post('/v13/apresentacao/ler', json={'pptx_b64': base64.b64encode(pptx).decode()}, headers=h)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j['roteiro']['titulo_arquivo'] == 'AGE teste' and len(j['fotos']) == 3 and len(j['documentos_paginas']) == 2
    buf = io.BytesIO()
    Presentation().save(buf)
    r = cli.post('/v13/apresentacao/ler', json={'pptx_b64': base64.b64encode(buf.getvalue()).decode()}, headers=h)
    assert r.status_code == 422
    assert r.json()['detail'] == {'erro': 'sem_roteiro', 'detalhe': 'Esta apresentação não foi gerada pelo sistema. Gere uma nova.'}
    assert cli.post('/v13/apresentacao/ler', json={'pptx_b64': 'x'}, headers=h).status_code == 422
    assert cli.post('/v13/apresentacao/ler', json={'pptx_b64': base64.b64encode(pptx).decode()}).status_code in (401, 503)
    # páginas prontas pela rota de montar
    pg = j['documentos_paginas'][0]
    corpo = {'roteiro': {'slides': [{'tipo': 'capa', 'condominio': 'C', 'data': 'hoje'},
                                    {'tipo': 'documento', 'titulo': 'D', 'documento': 'd1', 'paginas': [1]}]},
             'fotos': [], 'documentos': [], 'documentos_paginas': [pg]}
    r = cli.post('/v13/apresentacao', json=corpo, headers=h)
    assert r.status_code == 200 and r.json()['slides'] == 2
    corpo['documentos_paginas'] = [{'id': 'd1', 'pagina': 'um', 'b64': pg['b64']}]
    assert cli.post('/v13/apresentacao', json=corpo, headers=h).status_code == 422


def test_rota_http():
    cli, h = _cliente()
    corpo = {'roteiro': {'slides': [{'tipo': 'capa', 'condominio': 'Cond', 'data': 'hoje'},
                                    {'tipo': 'fotos', 'titulo': 'F', 'fotos': [{'id': 'f1'}]}, {'tipo': 'encerramento'}]},
             'fotos': [{'id': 'f1', 'b64': base64.b64encode(_foto()).decode()}], 'documentos': [],
             'logo_cliente_b64': base64.b64encode(_logo()).decode()}
    r = cli.post('/v13/apresentacao', json=corpo, headers=h)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j['slides'] == 3 and base64.b64decode(j['pdf_b64'])[:4] == b'%PDF' and isinstance(j['avisos'], list)
    assert cli.post('/v13/apresentacao', json={'roteiro': {}}, headers=h).status_code == 422
    r = cli.post('/v13/apresentacao', json={**corpo, 'documentos': [{'id': 'd1', 'b64': base64.b64encode(b'oi').decode()}]}, headers=h)
    assert r.status_code == 422 and r.json()['detail']['erro'] == 'entrada_invalida'
    assert cli.post('/v13/apresentacao', json=corpo).status_code in (401, 503)


# ── componentes da AGE de referência: pauta 4x3, tabela de 15 com chips, galeria 8, capa com
#    foto, gráfico de colunas, painel, fases e foto com etapas ──

def _rotulada():
    im = Image.new('RGB', (1600, 600), 'white')
    d = ImageDraw.Draw(im)
    for i in range(5):
        d.rectangle([40 + i * 310, 60, 320 + i * 310, 480], fill=(160, 40 + i * 30, 60))
        d.text((60 + i * 310, 515), f'{i + 1}. ETAPA', fill='black')
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


EXPLICA = ('O saldo ficou negativo porque a parcela da obra da portaria foi paga em setembro antes da entrada '
           'da taxa extra, que só cai em outubro, conforme o sistema.')
NC = [('Ausência de projeto de segurança contra incêndio e pânico', 'Crítica'), ('Ausência de AVCB', 'CRÍTICA'),
      ('Trincas nas soldas das coberturas', 'critica'), ('Ausência de ARTs e laudos', 'Alta'), ('Quadro subdimensionado', 'Alta'),
      ('Bombas sem redundância', 'Alta'), ('SPA sem bypass', 'Alta'), ('Espaço confinado sem NR 33', 'Alta'),
      ('Ausência de projeto elétrico', 'Alta'), ('Pontos de oxidação', 'Alta'), ('Circuitos sem identificação', 'Média'),
      ('Quadros sem reserva técnica', 'media'), ('Quadros sem travamento', 'MÉDIA'), ('Oxidação nos portões', 'Média'),
      ('Falta de paisagismo na entrada de energia', 'Baixa')]
PAUTA9 = [{'titulo': t, 'subtitulo': 'Resumo do item', 'etiqueta': e} for t, e in
          [('Prestação de contas', 'APRESENTAÇÃO'), ('Agronegócio e segurança', 'APRESENTAÇÃO'), ('Planejamento', 'APRESENTAÇÃO'),
           ('Áreas de eventos', 'DEFINIÇÃO'), ('Comissão de Vistoria', 'APRESENTAÇÃO'), ('Divergência estatutária', 'VOTAÇÃO'),
           ('Inadimplência', 'VOTAÇÃO'), ('Entrega', 'DELIBERAÇÃO'), ('Assuntos gerais', 'ABERTO')]]
NOVOS = {'slides': [
    {'tipo': 'capa', 'assembleia': 'Assembleia Geral Extraordinária', 'condominio': 'Associação de Moradores Fazenda Barão do Império',
     'data': '24 de outubro de 2026', 'chamadas': ['1ª chamada às 8h30', '2ª chamada às 9h00'], 'foto': 'f1',
     'foto_legenda': 'Portaria da Fazenda Barão do Império, Santa Leopoldina/ES'},
    {'tipo': 'pauta', 'itens': PAUTA9},
    {'tipo': 'pauta', 'itens': PAUTA9 + [{'titulo': 'Eleição do conselho', 'etiqueta': 'ELEIÇÃO'}, {'titulo': 'Reforma do salão', 'etiqueta': 'VOTAÇÃO'},
                                         {'titulo': 'Fundo de obras', 'etiqueta': 'VOTAÇÃO'}]},
    {'tipo': 'tabela', 'numero': 5, 'titulo': 'Todas as não conformidades', 'colunas': ['Nº', 'Não conformidade', 'Criticidade'],
     'linhas': [[str(i + 1), n, c] for i, (n, c) in enumerate(NC)], 'chips': {'coluna': 2}},
    {'tipo': 'tabela', 'numero': 5, 'titulo': 'Pendências', 'colunas': ['Pendência', 'Situação'],
     'linhas': [['AVCB', 'Atrasado'], ['Laudo', 'Concluído']], 'chips': {'coluna': 1, 'cores': {'Atrasado': 'vermelho', 'Concluído': 'verde'}}},
    {'tipo': 'tabela', 'numero': 5, 'titulo': 'Dezesseis linhas', 'colunas': ['Item', 'Valor'],
     'linhas': [[f'Serviço {i}', f'R$ {i}.000,00'] for i in range(1, 17)]},
    {'tipo': 'topicos', 'numero': 2, 'titulo': 'Seis tópicos longos', 'subtitulo': 'Situação levantada',
     'topicos': ['Cercamento entre as Fases B e C ainda aberto, com acesso livre pela estrada vicinal ao norte da fazenda'] * 6},
    {'tipo': 'topicos', 'numero': 2, 'titulo': 'Nove tópicos', 'topicos': [f'Tópico {i}' for i in range(1, 10)]},
    {'tipo': 'fotos', 'numero': 2, 'titulo': 'Oito fotos', 'fotos': [{'id': f'f{i}', 'legenda': f'Foto {i}'} for i in range(1, 9)]},
    {'tipo': 'grafico_colunas', 'numero': 1, 'titulo': 'Receitas e despesas de cada mês', 'categorias': ['jul/26', 'ago/26', 'set/26'],
     'series': [{'nome': 'Receitas', 'valores': [405384.08, 422385.80, 237445.82]}, {'nome': 'Despesas', 'valores': [662.05, 184512.88, -2276.0]}],
     'cards': [{'rotulo': '31/07/2026', 'valor': 'R$ 423.013,13'}, {'rotulo': 'Resultado de set/26', 'valor': '(R$ 1.234,56)', 'sub': 'saldo'}],
     'nota': 'A receita de setembro foi menor porque não houve entrada da Taxa VAZ.'},
    {'tipo': 'grafico_colunas', 'numero': 1, 'titulo': 'Treze meses', 'categorias': [f'm{i:02d}/26' for i in range(1, 14)],
     'series': [{'nome': n, 'valores': [1000.0 * (i + k) for i in range(13)]} for k, n in enumerate(['A', 'B', 'C'])],
     'cards': [{'rotulo': f'Resultado de m0{i}/26', 'valor': '(R$ 9.000,00)', 'sub': EXPLICA} for i in range(1, 4)]
     + [{'rotulo': 'Saldo no fim do período', 'valor': 'R$ 100,00'}]},
    {'tipo': 'painel', 'numero': 1, 'titulo': 'Resultado do trimestre', 'subtitulo': 'Demonstrativo de julho a setembro de 2026',
     'cards': [{'rotulo': 'Saldo inicial', 'valor': 'R$ 18.291,10', 'sub': 'em 01/07/2026'},
               {'rotulo': 'Receitas', 'valor': 1065215.70, 'cor': 'verde'}, {'rotulo': 'Despesas', 'valor': 'R$ 412.793,52'},
               {'rotulo': 'Resultado', 'valor': '(R$ 12.450,33)', 'sub': EXPLICA},
               {'rotulo': 'Saldo final', 'valor': 'R$ 670.713,28', 'sub': EXPLICA, 'destaque': True},
               {'rotulo': 'Fundo de reserva', 'valor': 'R$ 1.000,00', 'sub': EXPLICA}],
     'faixa': [{'rotulo': 'A receita cobriu', 'valor': '258,1%'}, {'rotulo': 'O caixa cresceu', 'valor': '+R$ 652.422'},
               {'rotulo': 'Meses positivos', 'valor': '3 de 3'}]},
    {'tipo': 'fases', 'numero': 8, 'titulo': 'Implantação em três fases',
     'fases': [{'nome': f'Fase {x}', 'rotulo': '2 anos', 'blocos': [{'titulo': 'Início', 'texto': 'Começa no lançamento'},
                                                                   {'titulo': 'Cercamento', 'texto': 'Cercamento do perímetro externo da área'}]}
               for x in 'ABC'],
     'faixas': [{'destaque': '6 anos', 'texto': 'de prazo total compromissado com o município'},
                {'rotulo': 'Ponto de atenção', 'texto': 'Garantir a segurança durante as obras da Fase C'}]},
    {'tipo': 'foto_etapas', 'numero': 5, 'titulo': 'Estrutura metálica', 'fotos': ['f20', 'f20'],
     'etapas': [{'titulo': t, 'texto': 'descrição da etapa'} for t in ('Condição inicial', 'Penetrante', 'Limpeza', 'Revelador', 'Resultado final')]},
    {'tipo': 'foto_etapas', 'numero': 5, 'titulo': 'Sem imagem', 'fotos': ['f99'], 'etapas': [{'titulo': 'Início', 'texto': 'a'}]},
]}
FOTOS_NOVOS = dict({f'f{i}': _foto(((40 * i) % 220, 120, 90)) for i in range(1, 9)}, f20=_rotulada())


@pytest.fixture(scope='module')
def novos():
    with tempfile.TemporaryDirectory() as tmp:
        prs, avisos = A.desenhar(NOVOS, FOTOS_NOVOS, {}, tmp)
        caminho = os.path.join(tmp, 'novos.pptx')
        prs.save(caminho)
        problemas = A.auditar(caminho, tmp)
    return prs, avisos, problemas


def _slides_com(prs, trecho):
    out = []
    for s in prs.slides:
        txt = ' '.join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame).replace('\u00a0', ' ')
        if trecho in txt:
            out.append(s)
    return out


def test_novos_sem_sobreposicao_nem_saida(novos):
    prs, avisos, problemas = novos
    assert problemas == [], problemas
    assert not any('texto demais' in a or 'resuma' in a or 'longo' in a for a in avisos), avisos
    for s in prs.slides:
        for sh in s.shapes:
            assert sh.left >= 0 and sh.top >= 0
            assert sh.left + sh.width <= A.Inches(A.SW) + 10 and sh.top + sh.height <= A.Inches(A.SH) + 10


def test_pauta_em_grade_num_slide(novos):
    prs, _, _ = novos
    pautas = _slides_com(prs, 'Pauta da')
    assert len(pautas) == 2                     # 9 itens em 3x3 e 12 em 4x3, cada uma num slide só
    assert not any('(continuação)' in sh.text_frame.text for s in pautas for sh in s.shapes if sh.has_text_frame)
    txt = ' '.join(sh.text_frame.text for sh in pautas[1].shapes if sh.has_text_frame)
    assert '12' in txt and 'Fundo de obras' in txt and '12 ITENS' in txt
    with tempfile.TemporaryDirectory() as tmp:
        prs13, _ = A.desenhar({'slides': [{'tipo': 'pauta', 'itens': [f'Item {i}' for i in range(1, 14)]}]}, {}, {}, tmp)
    assert len(prs13.slides) == 2               # acima de 12 parte em 7 e 6


def test_tabela_15_linhas_com_chips(novos):
    prs, _, _ = novos
    tab = _slides_com(prs, 'Todas as não conformidades')
    assert len(tab) == 1                        # 15 linhas num slide só
    s = tab[0]
    tamanhos = {r.font.size.pt for sh in s.shapes if sh.has_text_frame for p in sh.text_frame.paragraphs for r in p.runs
                if r.text.startswith('Ausência')}
    assert tamanhos and min(tamanhos) >= 12
    cores = {}
    formas = [sh for sh in s.shapes]
    for i, sh in enumerate(formas):
        if sh.has_text_frame and sh.text_frame.text in ('CRÍTICA', 'ALTA', 'MÉDIA', 'BAIXA', 'CRITICA', 'MEDIA'):
            fundo = formas[i - 1]                  # o chip desenha a pílula e logo depois o texto
            cores.setdefault(_sem(sh.text_frame.text), set()).add(str(fundo.fill.fore_color.rgb))
    assert cores == {'critica': {'FF7A7A'}, 'alta': {'F2B84B'}, 'media': {'63ABCF'}, 'baixa': {'3EE08F'}}
    pend = _slides_com(prs, 'Pendências')[0]
    f = [sh for sh in pend.shapes]
    atras = [f[i - 1] for i, sh in enumerate(f) if sh.has_text_frame and sh.text_frame.text == 'ATRASADO'][0]
    assert str(atras.fill.fore_color.rgb) == 'FF7A7A'
    dez = _slides_com(prs, 'Dezesseis linhas')
    assert len(dez) == 2 and '(continuação)' in ' '.join(sh.text_frame.text for sh in dez[1].shapes if sh.has_text_frame)


def _sem(t):
    return A._sem_acento(t)


def test_topicos_ate_6_num_slide(novos):
    prs, _, _ = novos
    assert len(_slides_com(prs, 'Seis tópicos longos')) == 1
    nove = _slides_com(prs, 'Nove tópicos')
    assert len(nove) == 2                       # 9 viram 5 e 4


def test_galeria_8_e_capa_com_foto_rastreaveis(novos):
    prs, _, _ = novos
    capa = prs.slides[0]
    nomes_capa = [sh.name for sh in capa.shapes if sh.shape_type == 13]
    assert 'foto:f1' in nomes_capa
    assert 'Portaria da Fazenda' in ' '.join(sh.text_frame.text for sh in capa.shapes if sh.has_text_frame)
    gal = _slides_com(prs, 'Oito fotos')
    assert len(gal) == 1
    fotos = [sh for sh in gal[0].shapes if sh.shape_type == 13 and sh.name.startswith('foto:')]
    assert sorted(sh.name for sh in fotos) == sorted(f'foto:f{i}' for i in range(1, 9))
    assert any(sh.crop_left > 0 or sh.crop_top > 0 or sh.crop_right > 0 or sh.crop_bottom > 0 for sh in fotos)


def test_grafico_colunas_com_formas(novos):
    prs, avisos, _ = novos
    g = _slides_com(prs, 'Receitas e despesas de cada mês')[0]
    assert not any(getattr(sh, 'has_chart', False) and sh.has_chart for sh in g.shapes)
    txt = ' '.join(sh.text_frame.text for sh in g.shapes if sh.has_text_frame).replace('\u00a0', ' ')
    for trecho in ('R$ 100k', 'Receitas', 'Despesas', '405k', 'jul/26', 'R$ 423.013,13', 'NOTA'):
        assert trecho in txt, trecho
    vermelhos = [sh for sh in g.shapes if sh.shape_type == 1 and sh.fill.type == 1 and str(sh.fill.fore_color.rgb) == 'FF7A7A']
    assert vermelhos                            # despesa negativa abaixo do zero e cartão negativo
    # 13 meses com 3 explicações longas: o gráfico fica inteiro e os cartões vão para um painel em seguida.
    treze = _slides_com(prs, 'Treze meses')
    assert len(treze) == 2 and EXPLICA[:40] in ' '.join(sh.text_frame.text for sh in treze[1].shapes if sh.has_text_frame)


def test_painel_fases_e_foto_etapas(novos):
    prs, avisos, _ = novos
    assert len(EXPLICA) <= 160
    p = _slides_com(prs, 'Resultado do trimestre')
    assert len(p) == 1
    txt = ' '.join(sh.text_frame.text for sh in p[0].shapes if sh.has_text_frame).replace('\u00a0', ' ')
    assert txt.count(EXPLICA[:30]) == 3 and '258,1%' in txt and 'R$ 1.065.215,70' in txt
    neg = [sh for sh in p[0].shapes if sh.has_text_frame and sh.text_frame.text.replace('\u00a0', ' ') == '(R$ 12.450,33)'][0]
    assert str(neg.text_frame.paragraphs[0].runs[0].font.color.rgb) == 'FF7A7A'
    f = _slides_com(prs, 'Implantação em três fases')[0]
    txt = ' '.join(sh.text_frame.text for sh in f.shapes if sh.has_text_frame)
    assert all(t in txt for t in ('FASE A', 'FASE C', '2 anos', '6 anos', 'PONTO DE ATENÇÃO', 'CERCAMENTO'))
    fe = _slides_com(prs, 'Estrutura metálica')[0]
    imgs = [sh for sh in fe.shapes if sh.shape_type == 13 and sh.name.startswith('foto:')]
    assert len(imgs) == 2 and all(sh.name == 'foto:f20' for sh in imgs)
    assert all(sh.crop_left == 0 and sh.crop_top == 0 and sh.crop_right == 0 and sh.crop_bottom == 0 for sh in imgs)
    txt = ' '.join(sh.text_frame.text for sh in fe.shapes if sh.has_text_frame)
    assert 'ETAPAS' in txt and 'Resultado final' in txt and '5' in txt
    assert any('as etapas saíram como passos' in a for a in avisos)
