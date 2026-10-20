# -*- coding: utf-8 -*-
"""
Extrai e cruza os relatorios do Superlogica para a prestacao de contas.

Uso:
  python3 extrair.py --inicio 2025-08 --fim 2026-09 --saida dados.json \
      relatorio1.pdf relatorio2.pdf ...

Aceita, em qualquer ordem e quantidade:
  W011A padrao      rubricas mes a mes (12 meses por arquivo)
  W011A detalhado   itens mes a mes ("; Detalhado" no cabecalho)
  W015A detalhado   comparativo de dois periodos, itens com total por coluna

Modo SIMPLES: so W011A padrao (ou W011A detalhado sem W015A cobrindo o periodo
nao e problema, ele ja traz os itens). Modo DETALHADO: existe alguma fonte de
itens (W011A detalhado ou W015A) que permite abrir cada rubrica.

Gera:
  dados.json          serie mensal, rubricas, itens por rubrica, saldos e
                      status de conciliacao de cada rubrica
  rascunho_composicao.json  texto inicial de cada rubrica para curadoria
Interrompe com erro quando os numeros nao fecham.
"""
import re, sys, json, argparse, subprocess, itertools
from collections import defaultdict, OrderedDict

NUM = r'-?\d{1,3}(?:\.\d{3})*,\d{2}'
MESES = {'jan': 1, 'fev': 2, 'mar': 3, 'abr': 4, 'mai': 5, 'jun': 6, 'jul': 7, 'ago': 8, 'set': 9, 'out': 10, 'nov': 11, 'dez': 12}
MES_ABR = {v: k.capitalize() for k, v in MESES.items()}
TOL = 0.02

def f(s): return float(s.replace('.', '').replace(',', '.'))
def norm(s): return re.sub(r'\s+', ' ', s).strip()
def cents(v): return int(round(v * 100))

def pdf_texto(path):
    return subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True, check=True).stdout.replace('\f', '\n')

def eh_rodape(s, nome):
    return (s == nome or 'CEP' in s or re.fullmatch(r'\d+ de \d+', s) is not None
            or re.fullmatch(r"[A-Za-zÀ-ú' ]+ / [A-Z]{2}", s) is not None)

def eh_cabecalho_categoria(ln, s):
    letras = re.sub(r'[^A-Za-zÀ-ú]', '', s)
    return ln.startswith(' ') and letras and s == s.upper() and not re.search(r'\d', s) and len(letras) >= 4

def nomes_categoria(lines):
    out = set()
    for l in lines:
        m = re.match(r'\s*Total de (.+?)\s{2,}-?\d', l)
        if m:
            nm = norm(m.group(1))
            if nm not in ('Receitas', 'Despesas') and len(nm) >= 4: out.add(nm)
    return out

def eh_categoria(ln, s, cats):
    return eh_cabecalho_categoria(ln, s) or (s == s.upper() and any(s.startswith(c) for c in cats))

def _linha_saldo(lines, i):
    """Le uma linha de saldo cujos numeros podem quebrar ('1.044.751,' + '40')."""
    tok = re.findall(r'-?[\d.]+,\d{0,2}', lines[i])
    vals = []; pend = []
    for t in tok:
        if re.fullmatch(r'-?[\d.]+,\d{2}', t): vals.append(t)
        else: vals.append(None); pend.append((len(vals) - 1, t))
    if pend:
        nxt = re.findall(r'\d{1,2}', lines[i + 1]) if i + 1 < len(lines) else []
        for (pos, t), comp in zip(pend, nxt): vals[pos] = t + comp
    return [f(v) if v else None for v in vals]

# ---------------------------------------------------------------- W011A
def parse_w011a(txt):
    lines = txt.split('\n')
    nome = re.match(r'W011A\s+(.+?)\s*\(', lines[0]).group(1).strip()
    detalhado = 'Detalhado' in '\n'.join(lines[:6])
    cab = next(l for l in lines if re.search(r'[A-Z][a-z]{2}/\d{4}', l) and len(re.findall(r'[A-Z][a-z]{2}/\d{4}', l)) >= 2)
    meses = ['%s-%02d' % (a, MESES[m.lower()]) for m, a in re.findall(r'([A-Z][a-z]{2})/(\d{4})', cab)]
    n = len(meses)
    i_ant = next(i for i, l in enumerate(lines) if l.strip().startswith('Saldo anterior'))
    saldo_ant = _linha_saldo(lines, i_ant)[:n]
    i_fim = [i for i, l in enumerate(lines) if l.strip().startswith('Saldo Final')]
    saldo_fim = _linha_saldo(lines, i_fim[0])[:n] if i_fim else None
    rec, desp, cat_tot = [], OrderedDict(), OrderedDict()
    tot_rec = tot_desp = None
    modo = None; cat = None; ultimo = None
    cats = nomes_categoria(lines)
    i0 = next(i for i, l in enumerate(lines) if l.strip() == 'Receitas')
    for ln in lines[i0 + 1:]:
        s = ln.strip()
        if not s or eh_rodape(s, nome): continue
        nums = re.findall(NUM, ln)
        nm = norm(re.split(NUM, s)[0])
        if s == 'Despesas': modo = 'desp'; continue
        if len(nums) >= n + 1:
            vals = [f(x) for x in nums[:n]]; tot = f(nums[n])
            if nm.startswith('Total de Receitas'): tot_rec = vals; ultimo = None; continue
            if nm.startswith('Total de Despesas'): tot_desp = vals; break
            if nm.startswith('Total de'):
                cat_tot[cat] = vals; ultimo = None; continue
            if nm.startswith('Mov.'): continue
            row = {'nome': nm, 'm': vals, 'tot': tot}
            if modo == 'desp': desp.setdefault(cat, []).append(row)
            else: rec.append(row)
            ultimo = row
        elif not nums:
            if modo == 'desp' and eh_categoria(ln, s, cats):
                cat = s; ultimo = None
            elif ultimo is not None and not ln.startswith('    '):
                ultimo['nome'] = norm(ultimo['nome'] + ' ' + s)
    assert tot_rec and tot_desp, "W011A sem totais"
    for k, v in cat_tot.items():
        soma = [round(sum(r['m'][j] for r in desp.get(k, [])), 2) for j in range(n)]
        assert all(abs(a - b) < TOL for a, b in zip(soma, v)), f"W011A: itens de {k} nao fecham com o total"
    return dict(tipo='W011A', detalhado=detalhado, nome=nome, meses=meses, saldo_ant=saldo_ant, saldo_fim=saldo_fim,
                receitas=rec, despesas=desp, tot_rec=tot_rec, tot_desp=tot_desp)

# ---------------------------------------------------------------- W015A
def _data(s):
    d, m, a = s.split('/'); a = int(a); a = a + 2000 if a < 100 else a
    return '%04d-%02d' % (a, int(m))

def parse_w015a(txt):
    lines = txt.split('\n')
    nome = re.match(r'W015A\s+(.+?)\s*\(', lines[0]).group(1).strip()
    i_h = next(i for i, l in enumerate(lines) if len(re.findall(r'\d{2}/\d{2}/\d{2,4} até', l)) >= 2)
    ini = re.findall(r'(\d{2}/\d{2}/\d{2,4}) até', lines[i_h])
    fim = re.findall(r'\d{2}/\d{2}/\d{2,4}', lines[i_h + 1])
    cols = [(_data(a), _data(b)) for a, b in zip(ini, fim)]
    i_ant = next(i for i, l in enumerate(lines) if l.strip().startswith('Saldo anterior'))
    saldo_ant = [f(x) for x in re.findall(NUM, lines[i_ant])]
    i_fim = next(i for i, l in enumerate(lines) if l.strip().startswith('Saldo Final'))
    saldo_fim = [f(x) for x in re.findall(NUM, lines[i_fim])]
    itens = []; modo = 'rec'; cat = None; ultimo = None
    cats = nomes_categoria(lines)
    i0 = next(i for i, l in enumerate(lines) if l.strip() == 'Receitas')
    for ln in lines[i0 + 1:]:
        s = ln.strip()
        if not s or eh_rodape(s, nome): continue
        nums = re.findall(NUM, ln)
        nm = norm(re.split(NUM, s)[0])
        if s == 'Despesas': modo = 'desp'; continue
        if len(nums) >= 3 and '%' in ln:
            if nm.startswith('Total de Despesas'): break
            if nm.startswith('Total de'): ultimo = None; continue
            row = {'sec': 'REC' if modo == 'rec' else cat, 'nome': nm, 'c': [f(nums[0]), f(nums[1])]}
            itens.append(row); ultimo = row
        elif not nums:
            if modo == 'desp' and eh_categoria(ln, s, cats):
                cat = s; ultimo = None
            elif ultimo is not None and not ln.startswith(' '):
                ultimo['nome'] = norm(ultimo['nome'] + ' ' + s)
    return dict(tipo='W015A', nome=nome, cols=cols, saldo_ant=saldo_ant, saldo_fim=saldo_fim, itens=itens)

# ---------------------------------------------------------------- utilidades
def meses_entre(a, b):
    y, m = map(int, a.split('-')); y2, m2 = map(int, b.split('-')); out = []
    while (y, m) <= (y2, m2):
        out.append('%04d-%02d' % (y, m)); m += 1
        if m == 13: y += 1; m = 1
    return out

def rotulo_mes(k): y, m = k.split('-'); return f"{MES_ABR[int(m)]}/{y[2:]}"

def casar(nome, opcoes):
    c = [o for o in opcoes if norm(nome).lower().startswith(norm(o).lower())]
    if not c:
        c = [o for o in opcoes if norm(nome).lower().replace(' ', '').startswith(norm(o).lower().replace(' ', ''))]
    return max(c, key=len) if c else None

def rotulo_item(nome, rub):
    s = norm(nome)[len(norm(rub)):] if norm(nome).lower().startswith(norm(rub).lower()) else norm(nome)
    s = re.sub(r'\((venc\.[^)]*)\)', '', s)
    s = re.sub(r'(?i)\bref\.?:?\s*(serviço de manutenção elétrica mês)?\s*[\d/]{6,8}(\(parc \d+\))?', '', s)
    s = re.sub(r'(?i)\b(parc\.?\s*\d+/\d+|\d+ de \d+|\(parcela \d/\d\))', '', s)
    s = re.sub(r'(?i)\bnf\s*\d+', '', s)
    s = s.strip(' -–.:,()´\'')
    return norm(s)

def subconjuntos(vals, alvo, limite=3000):
    vals = sorted(vals, key=lambda x: -x[1]); n = len(vals)
    suf = [0] * (n + 1)
    for i in range(n - 1, -1, -1): suf[i] = suf[i + 1] + vals[i][1]
    out = []
    def rec(i, rest, cur):
        if len(out) >= limite: return
        if rest == 0: out.append(list(cur)); return
        if i == n or rest < 0 or suf[i] < rest: return
        cur.append(vals[i][0]); rec(i + 1, rest - vals[i][1], cur); cur.pop()
        rec(i + 1, rest, cur)
    rec(0, alvo, []); return out

def particao_mensal(valores, serie, limite=20):
    """Distribui itens (valores em centavos) nos meses da serie (centavos) +
    um balde 'fora do periodo'. Retorna lista de conjuntos 'fora'."""
    n = len(valores); ordem = sorted(range(n), key=lambda k: -valores[k]); sols = []; passos = [0]
    def atribui(mi, usados):
        passos[0] += 1
        if len(sols) >= limite or passos[0] > 200000: return
        if mi == len(serie): sols.append(frozenset(k for k in range(n) if not usados >> k & 1)); return
        alvo = serie[mi]
        if alvo == 0: atribui(mi + 1, usados); return
        livres = [k for k in ordem if not usados >> k & 1]
        def rec(j, rest, cur):
            passos[0] += 1
            if len(sols) >= limite or passos[0] > 200000: return
            if rest == 0:
                u = usados
                for k in cur: u |= 1 << k
                atribui(mi + 1, u); return
            for t in range(j, len(livres)):
                k = livres[t]
                if valores[k] <= rest:
                    cur.append(k); rec(t + 1, rest - valores[k], cur); cur.pop()
        rec(0, alvo, [])
    atribui(0, 0); return sols

# ---------------------------------------------------------------- principal
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdfs', nargs='+'); ap.add_argument('--inicio', required=True); ap.add_argument('--fim', required=True)
    ap.add_argument('--saida', default='dados.json'); ap.add_argument('--rascunho', default='rascunho_composicao.json')
    a = ap.parse_args()
    periodo = meses_entre(a.inicio, a.fim)
    w11, w15 = [], []
    for p in a.pdfs:
        t = pdf_texto(p); cab = t.split('\n')[0]
        if cab.startswith('W011A'): w11.append(parse_w011a(t))
        elif cab.startswith('W015A'): w15.append(parse_w015a(t))
        else: sys.exit(f"Relatorio nao reconhecido: {p} ({cab[:40]})")
    if not w11: sys.exit("Falta o W011A (demonstrativo mes a mes). Ele e obrigatorio para a serie mensal.")
    nome = w11[0]['nome']

    # 1) rubricas mes a mes. Padrao define os nomes das rubricas; detalhado
    #    cobre meses que nenhum padrao cobre, agrupando itens pela rubrica.
    padroes = [w for w in w11 if not w['detalhado']]; detalh11 = [w for w in w11 if w['detalhado']]
    nomes_rec = OrderedDict(); nomes_desp = OrderedDict()
    for w in padroes:
        for r in w['receitas']: nomes_rec[r['nome']] = 1
        for c, rows in w['despesas'].items():
            for r in rows: nomes_desp.setdefault(c, OrderedDict())[r['nome']] = 1
    rec = defaultdict(lambda: defaultdict(float)); desp = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    tot_rec = {}; tot_desp = {}; saldo_ant = {}; saldo_fim = {}; fonte_mes = {}
    for w in padroes + detalh11:
        for j, mes in enumerate(w['meses']):
            if mes not in periodo: continue
            if mes in fonte_mes:
                assert abs(tot_rec[mes] - w['tot_rec'][j]) < TOL and abs(tot_desp[mes] - w['tot_desp'][j]) < TOL, \
                    f"Relatorios divergem em {mes}"
                continue
            fonte_mes[mes] = w
            tot_rec[mes] = w['tot_rec'][j]; tot_desp[mes] = w['tot_desp'][j]
            saldo_ant[mes] = w['saldo_ant'][j]
            if w['saldo_fim']: saldo_fim[mes] = w['saldo_fim'][j]
            for r in w['receitas']:
                k = r['nome'] if not w['detalhado'] else (casar(r['nome'], nomes_rec) or rotulo_base(r['nome']))
                rec[k][mes] += r['m'][j]
            for c, rows in w['despesas'].items():
                for r in rows:
                    k = r['nome'] if not w['detalhado'] else (casar(r['nome'], nomes_desp.get(c, {})) or rotulo_base(r['nome']))
                    desp[c][k][mes] += r['m'][j]
    falta = [m for m in periodo if m not in fonte_mes]
    if falta: sys.exit("Faltam meses no W011A: " + ", ".join(rotulo_mes(m) for m in falta) + ". Pedir o W011A que cubra esses meses.")
    serie = lambda d: [round(d.get(m, 0.0), 2) for m in periodo]
    rec_m = [round(tot_rec[m], 2) for m in periodo]; desp_m = [round(tot_desp[m], 2) for m in periodo]
    s_ini = saldo_ant[periodo[0]]
    saldos = []; s = s_ini
    for r_, d_ in zip(rec_m, desp_m): s = round(s + r_ - d_, 2); saldos.append(s)
    if periodo[-1] in saldo_fim and saldo_fim[periodo[-1]] is not None:
        assert abs(saldos[-1] - saldo_fim[periodo[-1]]) < TOL, f"Saldo calculado {saldos[-1]} difere do relatorio {saldo_fim[periodo[-1]]}"
    receitas = [{'nome': k, 'serie': serie(v), 'total': round(sum(serie(v)), 2)} for k, v in rec.items()]
    receitas = [r for r in receitas if abs(r['total']) > 0.004]
    assert abs(sum(r['total'] for r in receitas) - sum(rec_m)) < TOL, "Receitas nao fecham"
    categorias = []
    for c, rubs in desp.items():
        rl = [{'nome': k, 'serie': serie(v), 'total': round(sum(serie(v)), 2), 'itens': [], 'status': 'sem_detalhe'} for k, v in rubs.items()]
        rl = [r for r in rl if abs(r['total']) > 0.004]
        if rl: categorias.append({'nome': c, 'total': round(sum(r['total'] for r in rl), 2), 'rubricas': rl})
    assert abs(sum(c['total'] for c in categorias) - sum(desp_m)) < TOL, "Despesas nao fecham"

    # 2) itens de cada rubrica (modo detalhado)
    modo = 'simples'
    col_exata = None
    for w in w15:
        for ci, (ci0, ci1) in enumerate(w['cols']):
            if ci0 == periodo[0] and ci1 == periodo[-1]: col_exata = (w, ci)
    cobre11 = [w for w in detalh11 if set(periodo) <= set(w['meses'])]
    fonte_itens = None
    if col_exata: fonte_itens = 'w015a_exato'
    elif cobre11: fonte_itens = 'w011a_detalhado'
    elif w15: fonte_itens = 'w015a_janela'
    if fonte_itens:
        modo = 'detalhado'
        itens_por = defaultdict(list)   # (cat, rubrica) -> [(nome, valor)]
        if fonte_itens == 'w015a_exato':
            w, ci = col_exata
            for it in w['itens']:
                if it['sec'] == 'REC' or abs(it['c'][ci]) < 0.004: continue
                k = casar(it['nome'], [r['nome'] for c in categorias if c['nome'] == it['sec'] for r in c['rubricas']])
                itens_por[(it['sec'], k)].append((it['nome'], it['c'][ci]))
        elif fonte_itens == 'w011a_detalhado':
            w = cobre11[0]; idx = [w['meses'].index(m) for m in periodo]
            for c, rows in w['despesas'].items():
                ops = [r['nome'] for cc in categorias if cc['nome'] == c for r in cc['rubricas']]
                for r in rows:
                    v = round(sum(r['m'][j] for j in idx), 2)
                    if abs(v) > 0.004: itens_por[(c, casar(r['nome'], ops))].append((r['nome'], v))
        for c in categorias:
            for r in c['rubricas']:
                if fonte_itens == 'w015a_janela':
                    _concilia_janela(r, c['nome'], [x['nome'] for x in c['rubricas']], w15, periodo)
                    continue
                lst = itens_por.get((c['nome'], r['nome']), [])
                soma = round(sum(v for _, v in lst), 2)
                r['status'] = 'exato' if abs(soma - r['total']) < TOL else f'diverge ({soma:.2f})'
                r['itens'] = _agrupa(lst, r['nome'])
        sem = [k for k in itens_por if k[1] is None]
        assert not sem, f"Itens sem rubrica: {sem[:5]}"

    dados = dict(condominio=nome, modo=modo, fonte_itens=fonte_itens, periodo=periodo,
                 meses_label=[rotulo_mes(m) for m in periodo], saldo_anterior=s_ini, saldo_final=saldos[-1],
                 receitas_mes=rec_m, despesas_mes=desp_m, saldo_fim_mes=saldos,
                 receitas=sorted(receitas, key=lambda r: -r['total']), categorias=sorted(categorias, key=lambda c: -c['total']))
    json.dump(dados, open(a.saida, 'w'), ensure_ascii=False, indent=1)
    json.dump(rascunho(dados), open(a.rascunho, 'w'), ensure_ascii=False, indent=1)
    print(f"{nome}: {len(periodo)} meses ({dados['meses_label'][0]} a {dados['meses_label'][-1]}), modo {modo}"
          + (f" via {fonte_itens}" if fonte_itens else ""))
    print(f"  receitas {sum(rec_m):,.2f}  despesas {sum(desp_m):,.2f}  saldo {s_ini:,.2f} -> {saldos[-1]:,.2f}")
    pend = [(c['nome'], r['nome'], r['status']) for c in dados['categorias'] for r in c['rubricas']
            if modo == 'detalhado' and r['status'] not in ('exato', 'resolvido')]
    if pend:
        print(f"  ATENCAO {len(pend)} rubrica(s) sem conciliacao exata (ver status em dados.json):")
        for p in pend[:15]: print("   ", p)

def rotulo_base(nome):
    return norm(re.split(r' \(| - | Ref', nome)[0])

def _agrupa(lst, rub):
    g = OrderedDict()
    for nome, v in lst:
        lab = rotulo_item(nome, rub)
        e = g.setdefault(lab, [0.0, 0]); e[0] += v; e[1] += 1
    return sorted([{'rotulo': k, 'valor': round(v, 2), 'qtd': q} for k, (v, q) in g.items()], key=lambda x: -x['valor'])

def _concilia_janela(r, cat, nomes_cat, w15, periodo):
    """W015A cuja coluna cobre mais que o periodo: descobre quais itens ficaram
    fora (pagos nos meses extras) por soma exata e, no empate, pela particao mensal."""
    w = w15[0]
    ci = next((i for i, (a0, a1) in enumerate(w['cols']) if a0 <= periodo[0] and a1 >= periodo[-1]), None)
    if ci is None: r['status'] = 'sem_coluna'; return
    oi = 1 - ci
    ops = [x for x in w['itens'] if x['sec'] == cat and casar(x['nome'], nomes_cat) == r['nome']]
    dentro = [x for x in ops if x['c'][ci] and x['c'][oi] and abs(x['c'][ci] - x['c'][oi]) < 0.005]
    parciais = [x for x in ops if x['c'][ci] and x['c'][oi] and abs(x['c'][ci] - x['c'][oi]) >= 0.005]
    alvo = cents(r['total']); soma = sum(cents(x['c'][ci]) for x in dentro)
    escolha = list(dentro)
    if parciais:
        r['status'] = 'parcial'; r['itens'] = _agrupa([(x['nome'], x['c'][ci]) for x in dentro + parciais], r['nome']); return
    dif = soma - alvo
    if dif < 0: r['status'] = 'falta'; r['itens'] = _agrupa([(x['nome'], x['c'][ci]) for x in dentro], r['nome']); return
    if dif > 0:
        sols = subconjuntos([(k, cents(x['c'][ci])) for k, x in enumerate(dentro)], dif)
        if not sols: r['status'] = 'sem_solucao'; r['itens'] = _agrupa([(x['nome'], x['c'][ci]) for x in dentro], r['nome']); return
        labs = {frozenset(rotulo_item(dentro[k]['nome'], r['nome']) for k in range(len(dentro)) if k not in s) for s in sols}
        fora = set(sols[0]); r['status'] = 'resolvido'
        if len(labs) > 1:
            r['status'] = 'ambiguo'
            if len(dentro) <= 60:
                ps = particao_mensal([cents(x['c'][ci]) for x in dentro], [cents(v) for v in r['serie']])
                if ps:
                    labp = {frozenset(rotulo_item(dentro[k]['nome'], r['nome']) for k in range(len(dentro)) if k not in s) for s in ps}
                    fora = set(ps[0]); r['status'] = 'resolvido' if len(labp) == 1 else 'ambiguo'
        escolha = [x for k, x in enumerate(dentro) if k not in fora]
    r['itens'] = _agrupa([(x['nome'], x['c'][ci]) for x in escolha], r['nome'])
    if r['status'] != 'ambiguo': r['status'] = 'resolvido' if dif else 'exato'

def _brl(v): return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

def rascunho(d):
    """Texto inicial por rubrica: itens com valor, do maior para o menor. Serve de
    base para a curadoria (ver references/composicao.md); sempre fecha com o total."""
    out = OrderedDict()
    for c in d['categorias']:
        for r in c['rubricas']:
            if d['modo'] != 'detalhado' or not r['itens']:
                out[r['nome']] = {'texto': '', 'fecha': False, 'status': r['status']}; continue
            partes = []
            for it in r['itens']:
                lab = it['rotulo'] or 'lançamentos sem descrição'
                q = f" ({it['qtd']} lançamentos)" if it['qtd'] > 1 else ''
                partes.append(f"{lab}{q} {_brl(it['valor'])}")
            if all(not it['rotulo'] for it in r['itens']):
                out[r['nome']] = {'texto': '', 'fecha': False, 'status': r['status'], 'obs': 'rubrica recorrente: escrever o que e e {n} meses'}
            else:
                out[r['nome']] = {'texto': ' · '.join(partes), 'fecha': True, 'status': r['status']}
    return out

if __name__ == '__main__':
    main()
