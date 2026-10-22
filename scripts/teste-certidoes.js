// Teste da T50 (certidões da prestação): leitura dos textos de cada certidão (tipo, situação,
// emissão, validade e CNPJ), rotas com banco, storage, cadastro, busca e extração falsos, e os
// alertas do Dashboard (vencendo, vencida, válida longe e sem certidão).
const express = require('express');
const http = require('http');
const C = require('../servico/certidoes');
const { cnpjsDoTexto } = require('../financeiro/entrada');

let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };

const CNPJ = '11.222.333/0001-81'; // do condomínio (válido)
const OUTRO = '11.444.777/0001-61'; // de outro condomínio (válido)
const HOJE = '2026-10-22';

// Textos como saem da extração dos PDFs reais (quebras de linha e caixa alta dos sites).
const TX = {
  federal: `MINISTÉRIO DA FAZENDA
Secretaria da Receita Federal do Brasil
Procuradoria-Geral da Fazenda Nacional
CERTIDÃO NEGATIVA DE DÉBITOS RELATIVOS AOS TRIBUTOS FEDERAIS E À DÍVIDA ATIVA DA UNIÃO
Nome: CONDOMINIO RESIDENCIAL TESTE
CNPJ: ${CNPJ}
Ressalvado o direito de a Fazenda Nacional cobrar e inscrever quaisquer dívidas de responsabilidade do sujeito
passivo acima identificado que vierem a ser apuradas, é certificado que não constam pendências em seu nome,
relativas a créditos tributários administrados pela Secretaria da Receita Federal do Brasil (RFB) e a inscrições
em Dívida Ativa da União (DAU) junto à Procuradoria-Geral da Fazenda Nacional (PGFN).
Esta certidão é válida para o estabelecimento matriz e suas filiais.
Certidão emitida gratuitamente com base na Portaria Conjunta RFB/PGFN nº 1.751, de 2/10/2014.
Emitida às 10:15:30 do dia 22/10/2026 <hora e data de Brasília>.
Válida até 20/04/2027.
Código de controle da certidão: ABCD.1234.EF56.7890
Qualquer rasura ou emenda invalidará este documento.`,
  federalPositivaEfeito: `MINISTÉRIO DA FAZENDA
Secretaria da Receita Federal do Brasil
Procuradoria-Geral da Fazenda Nacional
CERTIDÃO POSITIVA COM EFEITOS DE NEGATIVA DE DÉBITOS RELATIVOS AOS TRIBUTOS FEDERAIS E À DÍVIDA ATIVA DA UNIÃO
Nome: CONDOMINIO RESIDENCIAL TESTE
CNPJ: 11.222.333
Ressalvado o direito de a Fazenda Nacional cobrar e inscrever quaisquer dívidas de responsabilidade do sujeito
passivo acima identificado que vierem a ser apuradas, é certificado que constam débitos com exigibilidade suspensa.
Emitida às 09:02:11 do dia 21/10/2026 <hora e data de Brasília>.
Válida até 19/04/2027.`,
  trabalhista: `PODER JUDICIÁRIO
JUSTIÇA DO TRABALHO
CERTIDÃO NEGATIVA DE DÉBITOS TRABALHISTAS
Nome: CONDOMINIO RESIDENCIAL TESTE (MATRIZ E FILIAIS)
CNPJ: ${CNPJ}
Certidão nº: 12345678/2026
Expedição: 22/10/2026, às 10:20:11
Validade: 19/04/2027 - 180 (cento e oitenta) dias, contados da data de sua expedição.
Certifica-se que CONDOMINIO RESIDENCIAL TESTE (MATRIZ E FILIAIS), inscrito(a) no CNPJ sob o nº ${CNPJ},
NÃO CONSTA como inadimplente no Banco Nacional de Devedores Trabalhistas.
Certidão emitida com base nos arts. 642-A e 883-A da Consolidação das Leis do Trabalho.`,
  trabalhistaPositiva: `PODER JUDICIÁRIO
JUSTIÇA DO TRABALHO
CERTIDÃO POSITIVA DE DÉBITOS TRABALHISTAS
Nome: CONDOMINIO RESIDENCIAL TESTE
CNPJ: ${CNPJ}
Certidão nº: 9999/2026
Expedição: 22/10/2026, às 10:20:11
Validade: 19/04/2027 - 180 (cento e oitenta) dias, contados da data de sua expedição.
Certifica-se que o interessado CONSTA como inadimplente no Banco Nacional de Devedores Trabalhistas
em relação aos processos abaixo, com débito garantido ou não.`,
  trabalhistaEfeito: `PODER JUDICIÁRIO
JUSTIÇA DO TRABALHO
CERTIDÃO POSITIVA DE DÉBITOS TRABALHISTAS COM EFEITO DE NEGATIVA
Nome: CONDOMINIO RESIDENCIAL TESTE
CNPJ: ${CNPJ}
Expedição: 22/10/2026, às 10:20:11
Validade: 19/04/2027 - 180 (cento e oitenta) dias, contados da data de sua expedição.
Certifica-se que o interessado consta no Banco Nacional de Devedores Trabalhistas com débito garantido
por depósito, bloqueio de numerário ou penhora de bens suficientes.`,
  fgts: `Certificado de Regularidade do FGTS - CRF
Inscrição: ${CNPJ}
Razão Social: CONDOMINIO RESIDENCIAL TESTE
Endereço: RUA DAS PALMEIRAS 100 / CENTRO / SERRA / ES / 29160-000
A Caixa Econômica Federal, no uso da atribuição que lhe confere o Art. 7, da Lei 8.036, de 11 de maio de 1990,
certifica que, nesta data, a empresa acima identificada encontra-se em situação regular perante o Fundo de
Garantia do Tempo de Servico - FGTS.
O presente Certificado não servirá de prova contra cobrança de quaisquer débitos referentes a contribuições
e/ou encargos devidos, decorrentes das obrigações com o FGTS.
Validade: 17/10/2026 a 15/11/2026
Certificação Número: 2026101700000000000000
Informação obtida em 22/10/2026 10:15:30
A utilização deste Certificado para os fins previstos em Lei esta condicionada a verificação de autenticidade
no site da Caixa: www.caixa.gov.br`,
  estadual: `GOVERNO DO ESTADO DO ESPÍRITO SANTO
SECRETARIA DE ESTADO DA FAZENDA
CERTIDÃO NEGATIVA DE DÉBITOS PARA COM A FAZENDA PÚBLICA ESTADUAL
Certidão nº 2026.000123456
Nome/Razão Social: CONDOMINIO RESIDENCIAL TESTE
CNPJ: ${CNPJ.replace(/\D/g, '')}
Certificamos que, até a presente data, não constam débitos de responsabilidade do contribuinte acima
identificado inscritos ou não em Dívida Ativa do Estado do Espírito Santo.
Data de Emissão: 22/10/2026
Validade: 21/12/2026
Vitória, 22 de outubro de 2026.`,
  municipalVitoria: `PREFEITURA MUNICIPAL DE VITÓRIA
SECRETARIA MUNICIPAL DE FAZENDA
CERTIDÃO NEGATIVA DE DÉBITOS
Contribuinte: CONDOMINIO RESIDENCIAL TESTE
CPF/CNPJ: ${CNPJ}
Certificamos, para os devidos fins, que não constam débitos tributários vencidos em nome do contribuinte
acima identificado junto à Fazenda Pública do Município de Vitória até a presente data.
Esta certidão é válida por 60 (sessenta) dias a partir da data de sua emissão.
Emitida em 22/10/2026 às 10:30.
Código de autenticidade: XYZ123`,
  municipalSerra: `PREFEITURA MUNICIPAL DA SERRA
ESTADO DO ESPÍRITO SANTO
SECRETARIA DE FAZENDA
CERTIDÃO POSITIVA COM EFEITO DE NEGATIVA DE DÉBITOS MUNICIPAIS
Certificamos que o contribuinte CONDOMINIO RESIDENCIAL TESTE, CNPJ ${CNPJ}, possui débitos com
exigibilidade suspensa junto ao Município da Serra, na forma do Código Tributário Nacional.
Data de emissão: 22/10/2026
Válida até: 20/01/2027`,
  falencia: `PODER JUDICIÁRIO DO ESTADO DO ESPÍRITO SANTO
TRIBUNAL DE JUSTIÇA
CERTIDÃO NEGATIVA DE FALÊNCIA, CONCORDATA E RECUPERAÇÃO JUDICIAL E EXTRAJUDICIAL
1ª Instância Comarca da Capital Vitória
Certificamos que, pesquisando os registros de distribuição de ações em nome de CONDOMINIO RESIDENCIAL TESTE,
CNPJ ${CNPJ}, NADA CONSTA quanto a pedidos de falência, concordata e recuperação judicial e extrajudicial.
Certidão emitida em 22/10/2026 às 11:00:00
Esta certidão é válida por 30 dias a contar da data de emissão.`,
  outroCnpj: `Certificado de Regularidade do FGTS - CRF
Inscrição: ${OUTRO}
Razão Social: CONDOMINIO VIZINHO
A Caixa Econômica Federal certifica que, nesta data, a empresa acima identificada encontra-se em situação
regular perante o Fundo de Garantia do Tempo de Servico - FGTS. Nada mais a declarar sobre este documento.
Validade: 17/10/2026 a 15/11/2026
Informação obtida em 22/10/2026 10:15:30`,
  semCnpj: `Certificado de Regularidade do FGTS - CRF
Razão Social: CONDOMINIO RESIDENCIAL TESTE
A Caixa Econômica Federal certifica que, nesta data, a empresa acima identificada encontra-se em situação
regular perante o Fundo de Garantia do Tempo de Servico - FGTS. Nada mais a declarar sobre este documento.
Validade: 17/10/2026 a 15/11/2026`,
  generico: `Declaração para os devidos fins que o condomínio abaixo identificado mantém suas obrigações em dia
junto a esta administradora, conforme registros internos consultados nesta data pela equipe responsável.
CNPJ ${CNPJ} documento emitido em 22/10/2026 sem validade definida para qualquer finalidade pública.`,
};

const opt = (tipoPedido) => ({ tipoPedido, cnpj: CNPJ, hojeIso: HOJE, cnpjsDoTexto });

// ---------- leitura pura ----------
const casos = [
  ['federal', TX.federal, 'negativa', '2026-10-22', '2027-04-20'],
  ['federal', TX.federalPositivaEfeito, 'positiva_com_efeito_negativa', '2026-10-21', '2027-04-19'],
  ['trabalhista', TX.trabalhista, 'negativa', '2026-10-22', '2027-04-19'],
  ['trabalhista', TX.trabalhistaPositiva, 'positiva', '2026-10-22', '2027-04-19'],
  ['trabalhista', TX.trabalhistaEfeito, 'positiva_com_efeito_negativa', '2026-10-22', '2027-04-19'],
  ['fgts', TX.fgts, 'negativa', '2026-10-22', '2026-11-15'],
  ['estadual', TX.estadual, 'negativa', '2026-10-22', '2026-12-21'],
  ['municipal', TX.municipalVitoria, 'negativa', '2026-10-22', '2026-12-21'],
  ['municipal', TX.municipalSerra, 'positiva_com_efeito_negativa', '2026-10-22', '2027-01-20'],
  ['falencia', TX.falencia, 'negativa', '2026-10-22', '2026-11-21'],
];
casos.forEach(([tipo, texto, sit, emi, val], i) => {
  const a = C.analisarTexto(texto, opt('auto'));
  t('caso ' + i + ' ' + tipo + ' tipo (veio ' + a.tipo + (a.erro ? ' ' + a.erro : '') + ')', a.tipo === tipo);
  t('caso ' + i + ' ' + tipo + ' situação (veio ' + a.situacao + ')', a.situacao === sit);
  t('caso ' + i + ' ' + tipo + ' emissão (veio ' + a.emitida_em + ')', a.emitida_em === emi);
  t('caso ' + i + ' ' + tipo + ' validade (veio ' + a.validade + ')', a.validade === val);
  // O mesmo texto no campo certo também passa.
  t('caso ' + i + ' no campo certo', C.analisarTexto(texto, opt(tipo)).tipo === tipo);
});
t('tipo diferente do campo', C.analisarTexto(TX.federal, opt('fgts')).erro === 'tipo_diferente');
t('outro CNPJ recusa', C.analisarTexto(TX.outroCnpj, opt('auto')).erro === 'cnpj_diferente');
t('outro CNPJ fala em outro CNPJ', /outro CNPJ/.test(C.analisarTexto(TX.outroCnpj, opt('auto')).detalhe));
t('sem CNPJ recusa', C.analisarTexto(TX.semCnpj, opt('auto')).erro === 'cnpj_diferente');
t('raiz do CNPJ só vale na federal', C.analisarTexto(TX.federalPositivaEfeito.replace('TRIBUTOS FEDERAIS', 'DEBITOS TRABALHISTAS'), opt('auto')).erro === 'cnpj_diferente');
t('sem texto (escaneado)', C.analisarTexto('', opt('auto')).erro === 'sem_texto' && /original/.test(C.analisarTexto('', opt('auto')).detalhe));
t('texto que não é certidão no automático', C.analisarTexto(TX.generico, opt('auto')).erro === 'tipo_nao_identificado');
t('texto não reconhecido no campo escolhido vale o campo', C.analisarTexto(TX.generico, opt('municipal')).tipo === 'municipal');
t('CNPJ com espaço solto', C.contemCnpj('CNPJ: 11.222.333/0001 - 81', CNPJ) && !C.contemCnpj('CNPJ: 111.222.333/0001-81', CNPJ));
t('validade absurda vira nula', C.analisarTexto(TX.fgts.replace('15/11/2026', '15/11/2036'), opt('auto')).validade === null);
t('FGTS irregular não é negativa', C.lerSituacao(C.normalizar('Certificado de Regularidade do FGTS empresa em situação irregular'), 'fgts') === 'desconhecida');
t('municipal fora das quatro', C.municipalDe('Guarapari').link === null && C.municipalDe('Guarapari').nome === 'Municipal (Guarapari)');
t('municipal Vila Velha', /vilavelha/.test(C.municipalDe('VILA VELHA').link) && C.municipalDe('Vila Velha').nome === 'Municipal (Vila Velha)');
t('nome de arquivo limpo', C.nomeArquivo('../../x<y>.pdf', 'fgts') === 'xy.pdf' && C.nomeArquivo('', 'fgts') === 'Certidao fgts.pdf');

// ---------- rotas ----------
const linhas = [];
const objetos = new Map();
function filtrar(qs) {
  const p = new URLSearchParams(qs || '');
  let l = linhas.slice();
  for (const [k, v] of p) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    if (v === 'not.is.null') { l = l.filter((x) => x[k] != null); continue; }
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    l = l.filter((x) => (op === 'eq' ? String(x[k]) === val : true));
  }
  return l;
}
let bancoFora = false;
async function banco(metodo, caminho, corpo) {
  if (bancoFora) return { status: 500, body: { erro: 'x' } };
  const qs = caminho.split('?')[1];
  if (metodo === 'GET') return { status: 200, body: filtrar(qs) };
  if (metodo === 'POST') {
    if (linhas.some((x) => x.id_superlogica === corpo.id_superlogica && x.tipo === corpo.tipo)) return { status: 409, body: { code: '23505' } };
    const n = { id: 'id' + linhas.length, ...corpo }; linhas.push(n); return { status: 201, body: [n] };
  }
  if (metodo === 'PATCH') { const alvo = filtrar(qs); alvo.forEach((x) => Object.assign(x, corpo)); return { status: 200, body: alvo }; }
  if (metodo === 'DELETE') { const alvo = filtrar(qs); alvo.forEach((x) => linhas.splice(linhas.indexOf(x), 1)); return { status: 200, body: alvo }; }
}
const cadastros = { 136: { nome: 'CONDOMINIO RESIDENCIAL TESTE', cnpj: CNPJ, endereco: { cidade: 'Serra' } }, 167: { nome: 'COND LONGE', cnpj: OUTRO, endereco: { cidade: 'Guarapari' } } };
const pdfDe = (chave) => Buffer.from('%PDF-1.4 ' + chave);
let buscas = 0;
const buscaFalsa = () => ({
  TIPOS_AUTOMATICOS: new Set(['fgts', 'falencia', 'municipal']),
  linkPreenchido: (tipo, cnpj) => (tipo === 'fgts' ? 'https://consulta-crf.caixa.gov.br/?cnpj=' + cnpj : tipo === 'trabalhista' ? 'javascript:alert(1)' : null),
  buscar: async (tipo, { cnpj }) => {
    buscas++;
    if (tipo === 'falencia') { const e = new Error('site caiu'); e.codigo = 'falhou'; throw e; }
    if (tipo === 'municipal') return { pdf: pdfDe('outroCnpj'), nome_arquivo: 'crf.pdf' };
    if (cnpj !== CNPJ.replace(/\D/g, '')) throw new Error('cnpj errado');
    return { pdf: pdfDe('fgts'), nome_arquivo: 'FGTS_CRF.pdf' };
  },
});
let leituraOk = true;
const app = express();
app.param('idSuperlogica', (req, res, next, v) => (/^[1-9][0-9]{0,8}$/.test(String(v)) ? next() : res.status(400).json({ erro: 'id_invalido' })));
const requireAuth = (req, res, next) => { req.user = { sub: '11111111-1111-4111-8111-111111111111' }; next(); };
C.criarRotasCertidoes(app, {
  requireAuth, express, banco, hoje: () => HOJE, busca: buscaFalsa,
  exigirLeituraSuperlogica: async (req, res) => { if (leituraOk) return true; res.status(403).json({ erro: 'acesso_negado' }); return false; },
  storageUpload: async (b, p, buf, tipo) => { if (b !== 'certidoes' || tipo !== 'application/pdf') throw new Error('bucket'); objetos.set(p, buf.length); },
  storageSignedUrl: async (b, p, seg) => 'https://x/' + p + '?s=' + seg,
  storageDelete: async (b, p) => { objetos.delete(p); },
  buscarCadastro: async (id) => { if (!cadastros[id]) throw new Error('sl'); return cadastros[id]; },
  extrairTexto: async (buf) => TX[buf.toString('latin1').slice(9)] || '',
});

const logOrig = console.log, warnOrig = console.warn;
const registros = [];
console.log = (s) => registros.push(String(s));
console.warn = () => {};
const srv = http.createServer(app).listen(0, async () => {
  const porta = srv.address().port;
  const pedir = (metodo, caminho, corpo, tipo) => new Promise((resolve) => {
    const dados = corpo == null ? null : Buffer.isBuffer(corpo) ? corpo : Buffer.from(JSON.stringify(corpo));
    const q = http.request({ port: porta, path: caminho, method: metodo, headers: dados ? { 'content-type': tipo || 'application/json', 'content-length': dados.length } : {} }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ st: res.statusCode, j }); });
    });
    if (dados) q.write(dados); q.end();
  });
  const bin = 'application/octet-stream';
  try {
    const g = await pedir('GET', '/api/certidoes/136');
    t('GET ok', g.st === 200 && g.j.cnpj === CNPJ && g.j.cidade === 'Serra' && g.j.tipos.length === 6 && g.j.certidoes.length === 0);
    const mun = g.j.tipos.find((x) => x.tipo === 'municipal');
    t('municipal da Serra', mun.nome === 'Municipal (Serra)' && /serra\.es\.gov\.br/.test(mun.link) && mun.automatica === true);
    t('link preenchido do FGTS', /cnpj=11222333000181$/.test(g.j.tipos.find((x) => x.tipo === 'fgts').link));
    t('link preenchido inseguro ignorado', /^https:\/\/cndt-certidao/.test(g.j.tipos.find((x) => x.tipo === 'trabalhista').link));
    t('federal é manual', g.j.tipos.find((x) => x.tipo === 'federal').automatica === false);
    const g2 = await pedir('GET', '/api/certidoes/167');
    t('cidade fora das quatro', g2.j.tipos.find((x) => x.tipo === 'municipal').link === null && g2.j.tipos.find((x) => x.tipo === 'municipal').nome === 'Municipal (Guarapari)');
    const g3 = await pedir('GET', '/api/certidoes/999');
    t('cadastro fora ainda lista com aviso', g3.st === 200 && g3.j.cnpj === null && !!g3.j.aviso);

    t('não PDF recusa', (await pedir('POST', '/api/certidoes/136/arquivo?tipo=auto', Buffer.from('oi'), bin)).st === 415);
    t('tipo inválido', (await pedir('POST', '/api/certidoes/136/arquivo?tipo=xpto', pdfDe('fgts'), bin)).st === 400);
    const up = await pedir('POST', '/api/certidoes/136/arquivo?tipo=auto&nome=' + encodeURIComponent('CRF FGTS.pdf'), pdfDe('fgts'), bin);
    t('envia FGTS automático', up.st === 200 && up.j.certidao.tipo === 'fgts' && up.j.certidao.situacao === 'negativa' && up.j.certidao.validade === '2026-11-15' && up.j.certidao.vencida === false);
    t('url temporária de 10 minutos', /136\/fgts\.pdf\?s=600$/.test(up.j.certidao.url));
    t('guardou no caminho do tipo', objetos.has('136/fgts.pdf') && linhas.length === 1 && linhas[0].origem === 'manual' && linhas[0].cnpj === '11222333000181' && linhas[0].arquivo_nome === 'CRF FGTS.pdf');
    t('log sem CNPJ', registros.some((r) => /cond=136 tipo=fgts/.test(r)) && !registros.some((r) => /11222333|11\.222/.test(r)));
    const up2 = await pedir('POST', '/api/certidoes/136/arquivo?tipo=fgts', pdfDe('fgts'), bin);
    t('substitui a do mesmo tipo', up2.st === 200 && linhas.length === 1);
    const r1 = await pedir('POST', '/api/certidoes/136/arquivo?tipo=fgts', pdfDe('federal'), bin);
    t('422 tipo_diferente', r1.st === 422 && r1.j.erro === 'tipo_diferente');
    const r2 = await pedir('POST', '/api/certidoes/136/arquivo?tipo=auto', pdfDe('outroCnpj'), bin);
    t('422 cnpj_diferente', r2.st === 422 && r2.j.erro === 'cnpj_diferente');
    const r3 = await pedir('POST', '/api/certidoes/136/arquivo?tipo=auto', pdfDe('vazio'), bin);
    t('422 sem_texto', r3.st === 422 && r3.j.erro === 'sem_texto');
    const r4 = await pedir('POST', '/api/certidoes/136/arquivo?tipo=auto', pdfDe('generico'), bin);
    t('422 tipo_nao_identificado', r4.st === 422 && r4.j.erro === 'tipo_nao_identificado');
    t('nada novo guardado nos erros', linhas.length === 1 && objetos.size === 1);
    const fed = await pedir('POST', '/api/certidoes/136/arquivo?tipo=auto', pdfDe('federal'), bin);
    t('envia federal', fed.st === 200 && fed.j.certidao.tipo === 'federal' && linhas.length === 2);

    t('buscar manual 409', (await pedir('POST', '/api/certidoes/136/buscar', { tipo: 'federal' })).st === 409);
    t('buscar tipo inválido 400', (await pedir('POST', '/api/certidoes/136/buscar', { tipo: 'x' })).st === 400);
    const b1 = await pedir('POST', '/api/certidoes/136/buscar', { tipo: 'fgts' });
    t('busca automática guarda', b1.st === 200 && b1.j.certidao.origem === 'automatica' && linhas.find((x) => x.tipo === 'fgts').arquivo_nome === 'FGTS_CRF.pdf');
    const b2 = await pedir('POST', '/api/certidoes/136/buscar', { tipo: 'fgts' });
    t('limite de 2 minutos 429', b2.st === 429 && /segundos/.test(b2.j.detalhe) && buscas === 1);
    const b3 = await pedir('POST', '/api/certidoes/136/buscar', { tipo: 'falencia' });
    t('site falhou 502', b3.st === 502 && b3.j.erro === 'falhou' && !/site caiu/.test(b3.j.detalhe));
    const b4 = await pedir('POST', '/api/certidoes/136/buscar', { tipo: 'municipal' });
    t('certidão baixada de outro CNPJ vira 502', b4.st === 502 && b4.j.erro === 'falhou' && !linhas.some((x) => x.tipo === 'municipal'));

    // Vencida no GET.
    linhas.push({ id_superlogica: 136, tipo: 'trabalhista', situacao: 'negativa', validade: '2026-10-01', caminho: '136/trabalhista.pdf', origem: 'manual' });
    const g4 = await pedir('GET', '/api/certidoes/136');
    t('vencida no GET', g4.j.certidoes.find((x) => x.tipo === 'trabalhista').vencida === true && g4.j.certidoes.find((x) => x.tipo === 'fgts').vencida === false);
    const del = await pedir('DELETE', '/api/certidoes/136/fgts');
    t('apaga', del.st === 200 && !linhas.some((x) => x.tipo === 'fgts') && !objetos.has('136/fgts.pdf'));
    t('apaga tipo inválido 400', (await pedir('DELETE', '/api/certidoes/136/xpto')).st === 400);
    leituraOk = false;
    t('sem acesso ao Superlógica 403', (await pedir('GET', '/api/certidoes/136')).st === 403 && (await pedir('POST', '/api/certidoes/136/arquivo?tipo=auto', pdfDe('fgts'), bin)).st === 403);
    leituraOk = true;
    bancoFora = true;
    t('banco fora 503', (await pedir('GET', '/api/certidoes/136')).st === 503);
    bancoFora = false;

    // ---------- alertas ----------
    const hoje = new Date(2026, 9, 22);
    linhas.length = 0;
    linhas.push(
      { id_superlogica: 136, tipo: 'fgts', situacao: 'negativa', validade: '2026-11-01' },
      { id_superlogica: 136, tipo: 'federal', situacao: 'negativa', validade: '2026-10-20' },
      { id_superlogica: 136, tipo: 'estadual', situacao: 'negativa', validade: '2027-01-30' },
      { id_superlogica: 136, tipo: 'municipal', situacao: 'negativa', validade: null },
    );
    const al = await C.gerarAlertasCertidoes(banco, '136', hoje);
    const vencendo = al.alertas.find((a) => a.tipo === 'certidao_vencendo');
    const vencida = al.alertas.find((a) => a.tipo === 'certidao_vencida');
    t('dois alertas (vencendo e vencida)', al.alertas.length === 2 && al.falhas.length === 0);
    t('vencendo: título, gravidade e chave', vencendo && vencendo.titulo === 'Certidão FGTS vence em 01/11/2026' && vencendo.detalhe.gravidade === 'media' && vencendo.chave === 'certidao:fgts:2026-11-01:vencendo' && /faltam 10 dias/.test(vencendo.detalhe.resumo));
    t('vencida: título, gravidade e chave', vencida && vencida.titulo === 'Certidão Federal venceu em 20/10/2026' && vencida.detalhe.gravidade === 'alta' && vencida.chave === 'certidao:federal:2026-10-20:vencida' && /há 2 dias/.test(vencida.detalhe.resumo));
    t('válida longe não alerta', !al.alertas.some((a) => a.detalhe.certidao === 'estadual'));
    t('sem certidão não alerta', (await C.gerarAlertasCertidoes(banco, '167', hoje)).alertas.length === 0);
    t('limite de 15 dias', (await C.gerarAlertasCertidoes(async () => ({ status: 200, body: [{ tipo: 'fgts', validade: '2026-11-06' }, { tipo: 'fgts', validade: '2026-11-07' }] }), '1', hoje)).alertas.length === 1);
    t('banco fora vira falha', (await C.gerarAlertasCertidoes(async () => ({ status: 500, body: null }), '1', hoje)).falhas[0] === 'certidões');
    t('tabela ainda não criada não acusa falha', (await C.gerarAlertasCertidoes(async () => ({ status: 404, body: { code: 'PGRST205' } }), '1', hoje)).falhas.length === 0);
  } catch (e) { t('sem exceção: ' + e.stack, false); }
  srv.close();
  console.log = logOrig; console.warn = warnOrig;
  console.log((falha ? 'FALHOU: ' : 'OK: ') + ok + ' certos, ' + falha + ' falhas');
  process.exit(falha ? 1 : 0);
});
