// Utilitários das regras do auditor financeiro (T25). Funções puras, sem rede e sem banco.
// Entrada: itens no formato do despesas/index e auditoria/index do Superlógica (API v2 condor).
'use strict';

// Cadastros que não são condomínios (empresas) e o condomínio de teste: fora de toda análise.
const IDS_EXCLUIDOS = new Set(['143', '144', '145', '160', '162']);
const ID_TESTE = '167';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => semAcento(s).toUpperCase().replace(/\s+/g, ' ').trim();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// Datas do Superlógica: "05/20/2026 00:00:00", "05/20/2026", "2026-05-20 00:00:00". Devolve AAAA-MM-DD ou null.
function data(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return m[3] + '-' + m[1] + '-' + m[2];
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return null;
}
// Datas escritas no texto da auditoria: DD/MM/AAAA.
function dataBR(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
}
function dias(a, b) { // b menos a, em dias
  if (!a || !b) return null;
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}
function maisDias(a, n) { const d = new Date(a + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Valor da API ("5218.85") ou do texto da auditoria ("R$ 4.143,26" ou "R$ 4143,26").
function valor(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function valorBR(s) {
  const t = String(s || '').replace(/R\$\s*/, '').trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const centavos = (v) => Math.round(valor(v) * 100);
// Textos para o detalhe do alerta: data DD/MM/AAAA e valor R$ 1.234,56.
const dataTexto = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '?');
const moeda = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function etiquetas(item) {
  return new Set((item.arquivos || []).filter((a) => a && String(a.fl_excluido_arq || '') !== '1')
    .map((a) => norm(a.st_nomeabreviadoetiqueta_eti)));
}
const temEtiqueta = (item, nome) => etiquetas(item).has(norm(nome));

function excluido(item) {
  const id = String(item.id_condominio_cond || '');
  return IDS_EXCLUIDOS.has(id) || id === ID_TESTE;
}

// Classificação da despesa pelo fornecedor e pela conta da apropriação (plano de contas).
// Concessionárias (energia, água, gás canalizado, telefone e internet) e impostos não exigem nota fiscal anexada.
const RX_CONCESSIONARIA_NOME = /\b(ESCELSA|EDP|CESAN|ES ?GAS|COMPANHIA DE GAS|SAAE|COPASA|SABESP|CEMIG|ENERGISA|LIGHT|VIVO|CLARO|TIM S|OI S|TELEFONICA|EMBRATEL|NET SERVICOS)\b/;
const RX_CONCESSIONARIA_CONTA = /^(ENERGIA|AGUA|ESGOTO|AGUA-ESGOTO|GAS|TELEFON|INTERNET|TELEFONIA)/;
const RX_IMPOSTO_NOME = /\b(RECEITA FEDERAL|PREFEITURA|PM [A-Z]|MUNICIPIO|DETRAN|SECRETARIA DA FAZENDA|SEFAZ|FGTS|INSS|DARF|DAE|DUA)\b/;
const RX_IMPOSTO_CONTA = /^(ISS|IRRF|IR |INSS|DARF|FGTS|PIS|COFINS|CSLL|CSRF|DUA|IPTU|TAXA|IMPOSTO|TRIBUTO|CONTRIBUICAO SINDICAL|SINDICATO|DCTF|ENCARGO)/;
// Folha, transferências, tarifas e repasses: não geram nota fiscal; ficam fora da R5 e da R1 por fornecedor e valor.
const RX_SEM_NOTA_CONTA = /^(SALARIO|ADIANTAMENTO|FERIAS|13|DECIMO|DEMISSAO|RESCISAO|VALE |BONIFICACAO|PENSAO|HONORARIOS SINDICO|TARIFAS? BANCARIA|TRANSFERENCIA|FLUXO CARTAO|REEMBOLSO|RESSARCIMENTO|FINANCIAMENTO|CUSTAS|PROCESSO|DESPESAS COM CARTORIO|CARTAO GVBUS|APLICACAO|RESGATE|DEVOLUCAO)/;
const RX_SEM_NOTA_NOME = /\b(FOLHA DE PAGTO|FOLHA DE PAGAMENTO|ADIANTAMENTO SALARIO|RESCISAO|FERIAS|VALE TRANSPORTE|GV-?BUS|SICOOB|BANESTES|BRADESCO S\.?A|ITAU|CAIXA ECONOMICA|BANCO DO BRASIL|TRIBUNAL|CARTORIO|SALARIOS? CONTRATADOS|BONIFICACAO)\b/;

function contasDe(item) { return (item.apropriacao || []).map((a) => norm(a && a.st_descricao_cont)).filter(Boolean); }

// Devolve 'debito_automatico' | 'concessionaria' | 'imposto' | 'sem_nota' | 'comum'.
function categoria(item) {
  const nome = norm(item.st_nome_con) + ' ' + norm(item.st_fantasia_con);
  const contas = contasDe(item);
  const forma = String(item.id_forma_pag || '');
  if (forma === '7') return 'debito_automatico';
  if (RX_CONCESSIONARIA_NOME.test(nome) || contas.some((c) => RX_CONCESSIONARIA_CONTA.test(c))) return 'concessionaria';
  if (forma === '13' || RX_IMPOSTO_NOME.test(nome) || contas.some((c) => RX_IMPOSTO_CONTA.test(c))) return 'imposto';
  if (RX_SEM_NOTA_NOME.test(nome) || (contas.length && contas.every((c) => RX_SEM_NOTA_CONTA.test(c)))) return 'sem_nota';
  return 'comum';
}

// Documento e código de barras que servem para comparar (descarta vazio, zero e marcações genéricas).
function documento(item) {
  const d = norm(item.st_documento_des).replace(/^(NF|NFE|NFS|NFSE|NOTA|DOC|N)[\s.:º°-]*/, '').replace(/^0+/, '');
  if (!d || d.length < 2 || /^(SN|S\/N|SEM|X+|-+)$/.test(d)) return '';
  return d;
}
function codigoBarras(item) {
  const c = soDigitos(item.st_codigobarras_pdes);
  if (c.length < 20 || /^0+$/.test(c)) return '';
  return c;
}
function fornecedorChave(item) {
  const cnpj = soDigitos(item.st_cpf_con);
  return cnpj.length >= 11 ? 'D' + cnpj : 'C' + String(item.id_contato_con || '');
}
function fornecedorNome(item) { return String(item.st_nome_con || item.st_fantasia_con || '').trim(); }

module.exports = {
  IDS_EXCLUIDOS, ID_TESTE, norm, dataTexto, moeda, soDigitos, data, dataBR, dias, maisDias, valor, valorBR, centavos,
  etiquetas, temEtiqueta, excluido, categoria, contasDe, documento, codigoBarras, fornecedorChave, fornecedorNome,
};
