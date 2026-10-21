# T29: monta a planilha de erros do financeiro a partir do alertas.json gerado por financeiro-rodar-regras.js.
# Uso: python3 scripts/financeiro_planilha_erros.py <alertas.json> <saida.xlsx>
# A planilha tem dado real: salvar fora do git (padrão ~/Downloads/Financeiro_erros_AAAA-MM-DD.xlsx).
import json
import sys
from collections import Counter, defaultdict

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ENT, SAI = sys.argv[1], sys.argv[2]
D = json.load(open(ENT, encoding='utf-8'))
AL = D['alertas']

ABAS = [
    ('R1_DOCUMENTO', 'Duplicidade documento', 'Mesmo documento do mesmo fornecedor ou mesmo código de barras, no mesmo condomínio, em despesas diferentes.'),
    ('R1_FORNECEDOR_VALOR', 'Duplicidade fornecedor valor', 'Mesmo fornecedor e mesmo valor no mesmo condomínio com vencimentos a até 10 dias. Fora: concessionárias, impostos, folha, débito automático, diaristas e prestadores semanais, e pares com documentos ou códigos de barras diferentes.'),
    ('R2_CONDOMINIO_TROCADO', 'Condomínio trocado', 'Mesmo código de barras, ou mesma nota do mesmo fornecedor, lançado em dois condomínios.'),
    ('R4_SEM_COMPROVANTE', 'Pago sem comprovante', 'Parcela paga sem arquivo com etiqueta Comprovante. Débito automático aparece com gravidade baixa.'),
    ('R4_ANEXO_REMOVIDO', 'Anexo removido após pagto', 'Arquivo removido de despesa já paga (auditoria dos últimos 10 dias úteis). Gravidade média quando outro arquivo foi vinculado no mesmo dia.'),
    ('R5_SEM_NOTA', 'Pago sem nota fiscal', 'Parcela paga sem arquivo com etiqueta Doc. Fiscal. Fora: concessionárias, impostos, débito automático, folha, tarifas, transferências e repasses.'),
    ('R6_VENCIDA', 'Vencida sem baixa', 'Parcela pendente com vencimento antes de hoje (vencimentos desde 01/01/2025).'),
    ('R8_LANCAMENTO_TARDIO', 'Lançada após vencimento', 'Despesa lançada no sistema depois do vencimento da parcela. Débito automático fica fora.'),
    ('R8_ANEXO_TARDIO', 'Anexo tardio', 'Comprovante, nota ou boleto anexado mais de 30 dias depois do pagamento. Comprovante tardio pesa menos que nota tardia.'),
    ('R8_PAGO_ATRASO', 'Pago com atraso sem juros', 'Paga depois do vencimento sem juros nem multa registrados. Atenção: a data de pagamento do Superlógica é pouco confiável (baixa em lote) e o juro nunca é registrado; conferir no boleto.'),
    ('R9_MEXIDA', 'Mexida por usuário', 'Remoção de anexo, alteração de valor ou vencimento, estorno, exclusão, pagamento cancelado e troca de fornecedor (auditoria dos últimos 10 dias úteis).'),
]
NOME_TIPO = {t: n for t, n, _ in ABAS}
GRAV = {'alta': 'Alta', 'media': 'Média', 'baixa': 'Baixa'}
ORD = {'alta': 0, 'media': 1, 'baixa': 2}
FORMA = {'0': 'Boleto', '1': 'Cheque', '2': 'Dinheiro', '3': 'Crédito', '4': 'Débito', '7': 'Débito automático', '8': 'Transferência',
         '9': 'Doc/Ted', '10': 'Outros', '12': 'Pix', '13': 'DCTFWeb', '14': 'Pix Copia e Cola'}
CAB = Font(bold=True, color='FFFFFF')
FUNDO = PatternFill('solid', fgColor='1F3864')
COR = {'alta': PatternFill('solid', fgColor='F8CBAD'), 'media': PatternFill('solid', fgColor='FFE699'), 'baixa': PatternFill('solid', fgColor='E2EFDA')}
MOEDA = '#,##0.00'


def br(d):
    if not d:
        return ''
    d = str(d)
    return d[8:10] + '/' + d[5:7] + '/' + d[0:4] + (d[10:16] if len(d) > 10 else '')


def cabecalho(ws, cols, larguras):
    ws.append(cols)
    for i, c in enumerate(ws[ws.max_row], 1):
        c.font, c.fill = CAB, FUNDO
        c.alignment = Alignment(wrap_text=True, vertical='center')
        ws.column_dimensions[get_column_letter(i)].width = larguras[i - 1] if i - 1 < len(larguras) else 14
    ws.freeze_panes = 'A' + str(ws.max_row + 1)


wb = Workbook()
rs = wb.active
rs.title = 'Resumo'
an_cond = D.get('analistas_por_condominio', {})
rs.append(['Erros do financeiro, caso a caso'])
rs['A1'].font = Font(bold=True, size=14)
dias = D.get('dias_auditoria', [])
def mdy(s):  # MM/DD/AAAA da auditoria para DD/MM/AAAA
    return s[3:5] + '/' + s[0:2] + '/' + s[6:10] if s else ''


rs.append(['Despesas pagas de 01/04/2026 até ' + br(D['hoje']) + ' e pendentes (vencidas desde 01/01/2025 e a vencer em 60 dias), ' + str(D['parcelas']) + ' parcelas. Auditoria: ' +
           str(len(dias)) + ' dias úteis (' + mdy(dias[0] if dias else '') + ' a ' + mdy(dias[-1] if dias else '') + ', ' +
           str(D['linhas_auditoria']) + ' registros).'])
for av in D.get('avisos', []):
    rs.append(['AVISO: ' + av])
    rs.cell(row=rs.max_row, column=1).font = Font(bold=True, color='C00000')
rs.append(['Fora da análise: cadastros de empresa 143, 144, 145, 160, 162 e o Residencial Teste (167). Leitura só, nada foi alterado no Superlógica.'])
rs.append([])

# Por tipo
rs.append(['Por tipo de erro'])
rs.cell(row=rs.max_row, column=1).font = Font(bold=True, size=12)
cabecalho(rs, ['Tipo', 'Alta', 'Média', 'Baixa', 'Total', 'Valor total (R$)', 'Condomínios'], [44, 10, 10, 10, 10, 18, 14])
rs.freeze_panes = None
por_tipo = defaultdict(list)
for a in AL:
    por_tipo[a['tipo']].append(a)
for t, nome, _ in ABAS:
    lst = por_tipo.get(t, [])
    g = Counter(a['gravidade'] for a in lst)
    rs.append([nome, g['alta'], g['media'], g['baixa'], len(lst), round(sum(a['valor'] or 0 for a in lst), 2), len({a['id_condominio'] for a in lst})])
    rs.cell(row=rs.max_row, column=6).number_format = MOEDA
rs.append([])

# Por condomínio
rs.append(['Por condomínio (quantidade de casos por tipo)'])
rs.cell(row=rs.max_row, column=1).font = Font(bold=True, size=12)
cols = ['Condomínio', 'Código', 'Analista provável', 'Total', 'Alta'] + [n for _, n, _ in ABAS]
ini = rs.max_row + 1
rs.append(cols)
for c in rs[rs.max_row]:
    c.font, c.fill = CAB, FUNDO
    c.alignment = Alignment(wrap_text=True, vertical='center')
por_cond = defaultdict(list)
for a in AL:
    por_cond[(a['id_condominio'], a['condominio'])].append(a)
nomes_cond = {}
for (idc, nome) in por_cond:
    if nome:
        nomes_cond[idc] = nome
agr = defaultdict(list)
for (idc, nome), lst in por_cond.items():
    agr[idc].extend(lst)
for idc, lst in sorted(agr.items(), key=lambda x: -len(x[1])):
    c = Counter(a['tipo'] for a in lst)
    rs.append([nomes_cond.get(idc, '[a confirmar]'), int(idc) if str(idc).isdigit() else idc, an_cond.get(str(idc), '[a confirmar]'), len(lst),
               sum(1 for a in lst if a['gravidade'] == 'alta')] + [c.get(t, 0) for t, _, _ in ABAS])
rs.append([])

# Por analista
rs.append(['Por analista (último usuário na despesa ou quem mais lançou no condomínio)'])
rs.cell(row=rs.max_row, column=1).font = Font(bold=True, size=12)
rs.append(['Analista', '', '', 'Total', 'Alta'] + [n for _, n, _ in ABAS])
for c in rs[rs.max_row]:
    c.font, c.fill = CAB, FUNDO
    c.alignment = Alignment(wrap_text=True, vertical='center')
por_an = defaultdict(list)
for a in AL:
    por_an[a.get('analista') or '[sem analista identificado]'].append(a)
for an, lst in sorted(por_an.items(), key=lambda x: -len(x[1])):
    c = Counter(a['tipo'] for a in lst)
    rs.append([an, '', '', len(lst), sum(1 for a in lst if a['gravidade'] == 'alta')] + [c.get(t, 0) for t, _, _ in ABAS])
for i, w in enumerate([42, 9, 22, 9, 9] + [14] * len(ABAS), 1):
    rs.column_dimensions[get_column_letter(i)].width = w
rs.row_dimensions[ini].height = 45


# Uma aba por tipo, caso a caso
grupos_num = {}
for t, nome, regra in ABAS:
    ws = wb.create_sheet(nome[:31])
    lst = sorted(por_tipo.get(t, []), key=lambda a: (ORD.get(a['gravidade'], 9), a['condominio'], -(a['valor'] or 0)))
    ws.append([regra])
    ws['A1'].alignment = Alignment(wrap_text=False)
    ws['A1'].font = Font(italic=True)
    r9 = t in ('R9_MEXIDA', 'R4_ANEXO_REMOVIDO')
    cols = ['Gravidade', 'Condomínio', 'Código', 'Analista', 'Origem do analista', 'Fornecedor', 'Documento', 'Valor (R$)',
            'Lançamento', 'Vencimento', 'Pagamento']
    larg = [10, 34, 8, 20, 22, 34, 16, 13, 12, 12, 12]
    if t.startswith('R1') or t.startswith('R2'):
        cols += ['Grupo', 'Código de barras', 'Despesas ligadas']
        larg += [8, 22, 22]
    if t in ('R6_VENCIDA', 'R8_LANCAMENTO_TARDIO', 'R8_ANEXO_TARDIO', 'R8_PAGO_ATRASO'):
        cols += ['Dias']
        larg += [7]
    if t == 'R8_ANEXO_TARDIO':
        cols += ['Data do anexo']
        larg += [12]
    if r9:
        cols += ['Usuário', 'Quando', 'O que mudou', 'Texto da auditoria']
        larg += [20, 17, 22, 60]
    cols += ['Forma de pagamento', 'Id despesa', 'Id parcela', 'Detalhe']
    larg += [16, 11, 11, 70]
    cabecalho(ws, cols, larg)
    for a in lst:
        linha = [GRAV.get(a['gravidade'], a['gravidade']), a['condominio'], int(a['id_condominio']) if str(a['id_condominio']).isdigit() else a['id_condominio'],
                 a.get('analista') or '[a confirmar]', a.get('analista_origem') or '', a['fornecedor'], a['documento'], a['valor'],
                 br(a.get('dt_lancamento')), br(a.get('dt_vencimento')), br(a.get('dt_liquidacao'))]
        if t.startswith('R1') or t.startswith('R2'):
            g = a.get('grupo') or ''
            if g not in grupos_num:
                grupos_num[g] = len(grupos_num) + 1
            linha += [grupos_num[g], a.get('codigo_barras') or '', ', '.join(a.get('relacionados') or [])]
        if t in ('R6_VENCIDA', 'R8_LANCAMENTO_TARDIO', 'R8_ANEXO_TARDIO', 'R8_PAGO_ATRASO'):
            linha += [a.get('dias_atraso')]
        if t == 'R8_ANEXO_TARDIO':
            linha += [br(a.get('dt_anexo'))]
        if r9:
            linha += [a.get('usuario') or '', br(a.get('quando')), a.get('mexida') or ('Remoção de anexo' + (' (trocado)' if a.get('substituido') else '')), a.get('texto_auditoria') or '']
        linha += [FORMA.get(str(a.get('forma_pagamento') or ''), ''), int(a['id_despesa']) if str(a['id_despesa']).isdigit() else a['id_despesa'],
                  int(a['id_parcela']) if str(a.get('id_parcela') or '').isdigit() else (a.get('id_parcela') or ''), a['detalhe']]
        # Texto vindo do Superlógica nunca vira fórmula.
        ws.append(linha)
        for c in ws[ws.max_row]:
            if c.data_type == 'f':
                c.data_type = 's'
        ws.cell(row=ws.max_row, column=1).fill = COR.get(a['gravidade'], PatternFill())
        ws.cell(row=ws.max_row, column=8).number_format = MOEDA
    ws.auto_filter.ref = 'A2:' + get_column_letter(len(cols)) + str(max(ws.max_row, 2))


ns = wb.create_sheet('Como ler')
notas = [
    'Como ler esta planilha',
    '',
    'Cada aba traz um tipo de erro, um caso por linha, ordenado por gravidade (alta, média, baixa), condomínio e valor.',
    'Analista: o último usuário que mexeu na despesa na auditoria; quando a despesa não foi mexida nos últimos 10 dias úteis, quem mais lançou despesas no condomínio nesse período. É uma indicação, não a carteira oficial.',
    'Nas abas de duplicidade e condomínio trocado, a coluna Grupo junta os lançamentos que se repetem entre si.',
    'Fonte: API do Superlógica, só leitura: despesas pagas por quinzena de pagamento, pendentes com vencimento a partir de 01/04/2026 e auditoria por dia.',
    '',
    'Limites conhecidos',
    'A auditoria cobre só os últimos 10 dias úteis: remoção de anexo, alterações e exclusões mais antigas não aparecem.',
    'O Superlógica nunca registra juros (o valor pago é sempre igual ao valor bruto) e muitas baixas são feitas em lote na data do vencimento: por isso a aba Pago com atraso sem juros é só um indício.',
    'Pendentes: vencidas desde 01/01/2025 (as anteriores a 01/04/2026 entram na aba Vencida sem baixa) e a vencer nos próximos 60 dias (entram só nas abas de duplicidade e condomínio trocado, para pegar antes de pagar).',
    'Arquivos ficam na despesa, não na parcela: numa despesa com várias parcelas pagas, as últimas além do número de comprovantes aparecem como sem comprovante.',
    'Pago com atraso sem juros: vencimento no fim de semana pago no dia útil seguinte não conta.',
    'Sem nota fiscal: além de concessionárias, impostos e débito automático, ficaram fora folha (salários, férias, rescisão, vales), tarifas bancárias, transferências, reembolsos e repasses, que não têm nota. Lista a confirmar com o financeiro.',
    'Duplicidade por fornecedor e valor: concessionárias ficam fora (várias unidades consumidoras, como a ESCELSA de R$ 39,48), assim como diaristas e prestadores semanais (lista branca e repetição semanal).',
    'Um mesmo documento com valor diferente pode ser contrato que repete o número todo mês ou nota dividida em parcelas: por isso aparece com gravidade baixa.',
    'Remoção de anexo com outro arquivo vinculado no mesmo dia costuma ser troca de arquivo: aparece com gravidade menor.',
]
for n in notas:
    ns.append([n])
ns['A1'].font = Font(bold=True, size=14)
ns['A8'].font = Font(bold=True, size=12)
ns.column_dimensions['A'].width = 160
wb.save(SAI)
print('planilha salva:', SAI, len(AL), 'casos')
