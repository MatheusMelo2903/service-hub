# -*- coding: utf-8 -*-
"""
Monta a apresentacao a partir de dados.json (extrair.py) e composicao.json
(curadoria feita pelo Claude seguindo references/composicao.md).

  python3 montar.py dados.json composicao.json --saida "Cond - Prestação de Contas.pptx" --pdf

Com --pdf: gera o PPTX, roda a auditoria visual e, so se ela passar, converte
para PDF na mesma pasta. Interrompe com erro em qualquer inconsistencia.
"""
import os, sys, json, re, shutil, subprocess, argparse
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import gerador as G

# Titulos e descricoes padrao das categorias do plano de contas do Superlogica.
# A curadoria pode sobrescrever qualquer campo em composicao.json["categorias"].
CAT_PADRAO = {
"DESPESA COM PESSOAL": ("Pessoal", "Despesas com", "pessoal", "Equipe que opera o condomínio, encargos e benefícios da equipe."),
"DESPESAS COM CONSUMO": ("Consumo", "Despesas com", "consumo", "Água, gás, energia das áreas comuns e telefone."),
"MANUTENÇÃO": ("Manutenção", "Contratos de", "manutenção", "Contratos fixos de manutenção do condomínio."),
"RETENÇÕES -NOTAS FISCAIS": ("Retenções de Notas Fiscais", "Retenções", "de notas fiscais", "Impostos retidos nas notas fiscais de serviço e recolhidos pelo condomínio."),
"DESPESA COM ADMINISTRATIVO": ("Administrativo", "Despesas", "administrativas", "Síndico, administradora, assessoria jurídica e despesas de escritório."),
"AQUISIÇÃO DE MATERIAIS": ("Aquisição de Materiais", "Aquisição de", "materiais", "Compras de materiais para limpeza, manutenção e melhorias."),
"SERVIÇOS": ("Serviços", "Serviços", "contratados", "Serviços avulsos de manutenção, obras e melhorias."),
"INVESTIMENTO-IMOBILIZADO": ("Investimento Imobilizado", "Investimento", "imobilizado", "Bens que passam a fazer parte do patrimônio do condomínio."),
"DESPESAS FINANCEIRAS": ("Despesas Financeiras", "Despesas", "financeiras", "Tarifas bancárias, imposto sobre rendimentos e taxas de cartão."),
"TAXAS E RECOLHIMENTOS": ("Taxas e Recolhimentos", "Taxas e", "recolhimentos", "Taxas obrigatórias de regularização do condomínio."),
"TAXA EXTRA": ("Taxa Extra", "Despesas da", "taxa extra", "Despesas custeadas pela arrecadação da taxa extra."),
}
# Grafia de exibicao das rubricas mais comuns (o nome do Superlogica vale quando nao estiver aqui)
NOME_PADRAO = {
"DARF INSS- CRF": "DARF INSS e CRF", "Serviço de Informática- Internet": "Serviço de Informática e Internet",
"Serviço Manutenção de Caixa d água": "Manutenção de Caixa d'Água", "Material de Construção-Ferramentas": "Material de Construção e Ferramentas",
"Eletrodoméstico-Eletroeletrônico": "Eletrodomésticos e Eletroeletrônicos", "ART - Taxa Conselho Regional Engenharia": "ART (Conselho Regional de Engenharia)",
"Serviço de Desentupimento-Desobstrução": "Desentupimento e Desobstrução", "Contrato Cx. de Gordura - Fossa e Esgoto": "Contrato Caixa de Gordura, Fossa e Esgoto",
"Demissão - Rescisão": "Demissão e Rescisão", "Subscrição de Capital - Integralização de juros": "Integralização de juros (capital)",
}

OCULTO = "não detalhado nesta apresentação"

def aplicar_estrutura(cats, est):
    """Ajustes de estrutura pedidos no Hub (composicao.json["estrutura"]). Os numeros
    nunca mudam: so muda como aparecem.
      renomear {chave_rubrica: nome}          renomear_categorias {categoria: nome}
      juntar [{rubricas: [chaves], nome}]     (dentro da mesma categoria; vira uma linha so)
      ocultar_rubricas [chaves]               (a linha fica, com valor, sem a composicao)
      ocultar_categorias [categorias]         (fica no grafico da distribuicao e nos totais,
                                               sem o slide de detalhamento)"""
    if not isinstance(est, dict) or not est:
        return cats
    ren = est.get('renomear') or {}
    rencat = est.get('renomear_categorias') or {}
    ocr = set(est.get('ocultar_rubricas') or [])
    occ = set(est.get('ocultar_categorias') or [])
    grupos = [g for g in (est.get('juntar') or []) if isinstance(g, dict)]
    for c in cats:
        antes = round(sum(r['valor'] for r in c['rubricas']), 2)
        for r in c['rubricas']:
            if isinstance(ren.get(r['chave']), str) and ren[r['chave']].strip():
                r['nome'] = ren[r['chave']].strip()
        for g in grupos:
            chaves = [k for k in (g.get('rubricas') or []) if any(r['chave'] == k for r in c['rubricas'])]
            if len(chaves) < 2:
                continue
            membros = [r for r in c['rubricas'] if r['chave'] in chaves]
            pos = c['rubricas'].index(membros[0])
            nome = (g.get('nome') or '').strip() or membros[0]['nome']
            novo = dict(chave='+'.join(chaves), nome=nome, valor=round(sum(m['valor'] for m in membros), 2),
                        comp='Reúne: ' + ', '.join(m['nome'] for m in membros) + '.', fecha=False,
                        serie=[round(sum(x), 2) for x in zip(*[m['serie'] for m in membros])])
            if all(m['chave'] in ocr for m in membros):
                ocr.add(novo['chave'])
            c['rubricas'] = [r for r in c['rubricas'] if r['chave'] not in chaves]
            c['rubricas'].insert(pos, novo)
        for r in c['rubricas']:
            if r['chave'] in ocr:
                r['comp'] = OCULTO[:1].upper() + OCULTO[1:] + '.'
                r['fecha'] = False
        c['rubricas'].sort(key=lambda r: -r['valor'])
        depois = round(sum(r['valor'] for r in c['rubricas']), 2)
        if abs(depois - antes) > 0.01:
            sys.exit(f"Ajuste de estrutura mudou o total de {c['nome']}: {antes:.2f} x {depois:.2f}")
        if isinstance(rencat.get(c['nome']), str) and rencat[c['nome']].strip():
            novo_nome = rencat[c['nome']].strip()
            c['curto'] = novo_nome
            partes = novo_nome.split(' ', 1)
            c['t1'], c['t2'] = partes[0], (partes[1] if len(partes) > 1 else '')
        if c['nome'] in occ:
            c['oculta'] = True
    return cats

def _titulo_padrao(cat):
    nome = cat.title()
    p = nome.split(' ', 1)
    return nome, p[0], (p[1] if len(p) > 1 else ''), ''

def garante_fontes():
    """LibreOffice precisa das fontes instaladas para o PDF sair com Poppins e Inter."""
    out = subprocess.run(['fc-list'], capture_output=True, text=True).stdout
    if 'Poppins' in out and 'Inter' in out: return
    dst = os.path.expanduser('~/.fonts'); os.makedirs(dst, exist_ok=True)
    for f in os.listdir(G.FONTES): shutil.copy(os.path.join(G.FONTES, f), dst)
    subprocess.run(['fc-cache', '-f'], capture_output=True)

def montar_cfg(d, comp):
    cli = comp['cliente']
    rubc = comp.get('rubricas', {}); catc = comp.get('categorias', {}); rnome = comp.get('receitas_nomes', {})
    meses = d['meses_label']; n = len(meses)
    detalhado = d['modo'] == 'detalhado'
    cats = []
    for c in d['categorias']:
        pad = CAT_PADRAO.get(c['nome'], _titulo_padrao(c['nome']))
        cc = catc.get(c['nome'], {})
        rubs = []
        for r in sorted(c['rubricas'], key=lambda r: -r['total']):
            rc = rubc.get(r['nome'], {})
            texto = rc.get('texto', '')
            if detalhado and not texto.strip():
                sys.exit(f"Composicao vazia para a rubrica '{r['nome']}' ({c['nome']}). No modo detalhado toda rubrica precisa de texto.")
            nm = sum(1 for v in r['serie'] if abs(v) > 0.004)
            rubs.append(dict(chave=r['nome'], nome=rc.get('nome', NOME_PADRAO.get(r['nome'], r['nome'])), valor=r['total'],
                             comp=texto.replace('{n}', str(nm)), fecha=bool(rc.get('fecha')), serie=r['serie']))
        cats.append(dict(nome=c['nome'], curto=cc.get('curto', pad[0]), t1=cc.get('t1', pad[1]), t2=cc.get('t2', pad[2]),
                         desc=cc.get('desc', pad[3]), nota=cc.get('nota'), total=c['total'], rubricas=rubs))
    cats = aplicar_estrutura(cats, comp.get('estrutura'))
    receitas = sorted([(rnome.get(r['nome'], NOME_PADRAO.get(r['nome'], r['nome'])), r['total']) for r in d['receitas']], key=lambda x: -x[1])
    RT = round(sum(d['receitas_mes']), 2); DT = round(sum(d['despesas_mes']), 2)
    ini = d['periodo'][0]; fim = d['periodo'][-1]
    MESX = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
    def ext(k): y, m = k.split('-'); return f"{MESX[int(m)-1]} de {y}"
    def lab(k): y, m = k.split('-'); return f"{G.MES_UP[int(m)-1]}/{y}"
    import calendar
    yf, mf = map(int, fim.split('-')); ultimo = calendar.monthrange(yf, mf)[1]
    insight = comp.get('receita_insight')
    if not insight and receitas:
        top = receitas[0]
        insight = f"{top[0]} responde por {G.pct(top[1]/RT*100)} da arrecadação no período."
    return dict(cliente_linha1=cli['linha1'], cliente_linha2=cli['linha2'], rodape=cli.get('rodape', (cli['linha1'] + ' ' + cli['linha2']).upper()),
                periodo_label=f"{lab(ini)} A {lab(fim)}", periodo_extenso=f"{ext(ini)} a {ext(fim)}",
                exercicio_titulo=f"Exercício {lab(ini)} a {lab(fim)}", n_meses=n,
                data_inicial=f"01/{ini[5:]}/{ini[:4]}", data_final=f"{ultimo:02d}/{fim[5:]}/{fim[:4]}",
                saldo_anterior=d['saldo_anterior'], receita_total=RT, despesa_total=DT, saldo_final=d['saldo_final'],
                meses_label=meses, receitas_mes=d['receitas_mes'], despesas_mes=d['despesas_mes'], saldo_fim_mes=d['saldo_fim_mes'],
                receitas_cat=receitas, despesas=sorted(cats, key=lambda c: -c['total']), receita_insight=insight)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dados'); ap.add_argument('composicao'); ap.add_argument('--saida', required=True)
    ap.add_argument('--pdf', action='store_true')
    a = ap.parse_args()
    d = json.load(open(a.dados)); comp = json.load(open(a.composicao))
    garante_fontes()
    cfg = montar_cfg(d, comp)
    G.montar(cfg, a.saida)
    print("PPTX:", a.saida)
    if a.pdf:
        r = subprocess.run([sys.executable, os.path.join(AQUI, 'auditar_apresentacao.py'), a.saida], capture_output=True, text=True)
        print(r.stdout.strip())
        if 'AUDITORIA OK' not in r.stdout: sys.exit("Auditoria reprovou: corrigir antes de gerar o PDF.")
        outdir = os.path.dirname(os.path.abspath(a.saida))
        subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', outdir, a.saida], capture_output=True, timeout=300)
        pdf = os.path.splitext(a.saida)[0] + '.pdf'
        if not os.path.exists(pdf): sys.exit("Falha ao converter para PDF")
        print("PDF:", pdf)

if __name__ == '__main__':
    main()
