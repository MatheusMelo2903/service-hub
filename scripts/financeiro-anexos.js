'use strict';
// T32: baixa e confere os anexos das despesas pagas de um período.
// Uso (variáveis do dev pelo railway run, nunca impressas):
//   railway run --service service-hub --environment dev -- node scripts/financeiro-anexos.js \
//     --saida /pasta/fora/do/git --condominios 114,21,118,94,80 --inicio 09/01/2026 --fim 09/30/2026
// Só GET no Superlógica. No máximo 2 downloads ao mesmo tempo; pausa de 2 s em 429 ou erro.
// Retoma: anexo já baixado com o mesmo tamanho não é baixado de novo.
const fs = require('fs');
const path = require('path');
const sl = require('../superlogica-dados.js');
const an = require('../financeiro/anexos.js');

function arg(nome, padrao) {
  const i = process.argv.indexOf('--' + nome);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const SAIDA = arg('saida');
const IDS = String(arg('condominios', '')).split(',').map(Number).filter((n) => n > 0);
const INICIO = arg('inicio'); const FIM = arg('fim');
const EXCLUIDOS = new Set([143, 144, 145, 160, 162]);
if (!SAIDA || !IDS.length || !INICIO || !FIM) { console.error('faltam --saida --condominios --inicio --fim'); process.exit(2); }
const PASTA = path.join(SAIDA, 'anexos');
fs.mkdirSync(PASTA, { recursive: true });

const conf = {
  base: (process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net').replace(/\/+$/, ''),
  appToken: process.env.SUPERLOGICA_APP_TOKEN || '',
  accessToken: process.env.SUPERLOGICA_ACCESS_TOKEN || '',
};
if (!conf.appToken || !conf.accessToken) { console.error('chaves do Superlógica ausentes'); process.exit(2); }
const cli = sl.criarCliente(conf);
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function emParalelo(tarefas, n) {
  let i = 0;
  async function trab() { while (i < tarefas.length) { const k = i++; await tarefas[k](); } }
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, trab));
}

async function despesasDoCondominio(id) {
  const todas = [];
  for (let pg = 1; pg <= 60; pg++) {
    const j = await cli.get('despesas/index', { status: 'liquidadas', comStatus: 'liquidadas', filtrarpor: 'liquidacao',
      dtInicio: INICIO, dtFim: FIM, idCondominio: id, itensPorPagina: 50, pagina: pg });
    if (!Array.isArray(j) || !j.length) break;
    todas.push(...j);
    if (j.length < 50) break;
    await espera(300);
  }
  return todas.filter((d) => String(d.id_condominio_cond) === String(id));
}

async function baixar(a, destino) {
  for (let t = 1; t <= 5; t++) {
    const r = await an.baixarAnexo(conf, a);
    if (r.status === 200 && an.corpoValido(r.corpo, a.st_extensao_arq)) { fs.writeFileSync(destino, r.corpo); return { ok: true }; }
    if (r.status === 200 || (r.status >= 400 && r.status < 500 && r.status !== 429)) {
      return { ok: false, erro: `HTTP ${r.status} corpo inválido (${r.corpo.slice(0, 60).toString('utf8').replace(/\s+/g, ' ')})` };
    }
    await espera(2000 * t);
  }
  return { ok: false, erro: 'falhou após 5 tentativas' };
}

(async () => {
  log('inicio', IDS.join(','), INICIO, FIM);
  const conds = [];
  for (let pg = 1; pg <= 5; pg++) {
    const j = await cli.get('condominios/get', { id: -1, somenteCondominiosAtivos: 1, itensPorPagina: 500, pagina: pg });
    if (!Array.isArray(j) || !j.length) break; conds.push(...j); if (j.length < 500) break;
  }
  const cnpjDe = new Map(); const nomeDe = new Map(); const outrosTodos = new Map();
  conds.forEach((c) => {
    const id = Number(c.id_condominio_cond); const doc = String(c.st_cnpj_cond || '').replace(/\D/g, '');
    nomeDe.set(id, c.st_fantasia_cond || c.st_nome_cond);
    if (doc.length === 14) { cnpjDe.set(id, doc); if (!EXCLUIDOS.has(id)) outrosTodos.set(doc, c.st_fantasia_cond || c.st_nome_cond); }
  });

  const itens = []; // um por anexo
  const despesasTodas = [];
  for (const id of IDS) {
    const linhas = await despesasDoCondominio(id);
    despesasTodas.push(...linhas);
    const porDesp = new Map();
    linhas.forEach((l) => { const k = l.id_despesa_des; if (!porDesp.has(k)) porDesp.set(k, []); porDesp.get(k).push(l); });
    let nAnexos = 0;
    porDesp.forEach((parcelas, idDesp) => {
      const vistos = new Set();
      parcelas.forEach((p) => (p.arquivos || []).forEach((a) => {
        if (vistos.has(a.id_arquivo_arq) || (a.fl_excluido_arq && a.fl_excluido_arq !== '0')) return;
        vistos.add(a.id_arquivo_arq); nAnexos++;
        itens.push({ idCond: id, idDesp, parcelas, anexo: a,
          arquivo: path.join(PASTA, `${id}_${idDesp}_${a.id_arquivo_arq}.${String(a.st_extensao_arq || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')}`) });
      }));
    });
    const semAnexo = [...porDesp.values()].filter((ps) => !ps.some((p) => (p.arquivos || []).length)).length;
    log('condominio', id, nomeDe.get(id), 'parcelas', linhas.length, 'despesas', porDesp.size, 'sem anexo', semAnexo, 'anexos', nAnexos);
    await espera(500);
  }
  fs.writeFileSync(path.join(SAIDA, 'despesas.json'), JSON.stringify(despesasTodas));

  let feitos = 0;
  await emParalelo(itens.map((it) => async () => {
    const tam = Number(it.anexo.nm_tamanho_arq) || -1;
    if (fs.existsSync(it.arquivo) && fs.statSync(it.arquivo).size === tam) { it.download = { ok: true, retomado: true }; }
    else it.download = await baixar(it.anexo, it.arquivo);
    if (++feitos % 25 === 0) log('downloads', feitos, 'de', itens.length);
  }), 2);
  log('downloads concluidos', itens.filter((i) => i.download.ok).length, 'de', itens.length);

  await emParalelo(itens.map((it) => async () => {
    if (!it.download.ok) return;
    const ext = String(it.anexo.st_extensao_arq || '').toLowerCase();
    if (ext !== 'pdf') { it.resultado = { tipo: an.tipoDoAnexo(it.anexo, ''), legivel: false, naoPdf: ext, achados: [] }; return; }
    const ex = await an.extrairPdf(it.arquivo);
    it.meta = ex.meta;
    it.resultado = an.conferirAnexo({ anexo: it.anexo, texto: ex.texto, meta: ex.meta, parcelas: it.parcelas,
      cnpjCond: cnpjDe.get(it.idCond) || '', outros: outrosTodos });
  }), 4);

  const saida = itens.map((it) => ({
    idCond: it.idCond, condominio: nomeDe.get(it.idCond), idDespesa: it.idDesp,
    fornecedor: it.parcelas[0].st_nome_con, valor: it.parcelas.map((p) => p.vl_valor_pdes).join(' + '),
    liquidacao: it.parcelas.map((p) => p.dt_liquidacao_pdes).join(' '), formaPag: it.parcelas[0].id_forma_pag,
    temCodigo: it.parcelas.some((p) => p.st_codigobarras_pdes),
    idArquivo: it.anexo.id_arquivo_arq, nomeArquivo: it.anexo.st_nome_arq, extensao: it.anexo.st_extensao_arq,
    etiqueta: [it.anexo.st_nomeabreviadoetiqueta_eti].concat((it.anexo.etiquetas || []).map((e) => e.st_nomeabreviadoetiqueta_eti)).filter(Boolean)[0] || '',
    envio: it.anexo.dt_envio_arq, download: it.download, produtor: it.meta ? it.meta.Producer || '' : '', criador: it.meta ? it.meta.Creator || '' : '',
    criacao: it.meta ? it.meta.CreationDate || '' : '', modificacao: it.meta ? it.meta.ModDate || '' : '',
    resultado: it.resultado || null,
  }));
  fs.writeFileSync(path.join(SAIDA, 'anexos.json'), JSON.stringify(saida, null, 1));
  const leg = saida.filter((s) => s.resultado && s.resultado.legivel).length;
  const esc = saida.filter((s) => s.resultado && !s.resultado.legivel && !s.resultado.naoPdf).length;
  log('FIM anexos', saida.length, 'legiveis', leg, 'escaneados', esc, 'achados', saida.reduce((a, s) => a + ((s.resultado && s.resultado.achados.length) || 0), 0));
})().catch((e) => { console.error('ERRO', e.message, e.status || ''); process.exit(1); });
