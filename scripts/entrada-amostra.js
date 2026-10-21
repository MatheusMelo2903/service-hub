// T33: taxa de leitura da entrada de documentos sobre PDFs já lançados (anexos baixados pela T32).
// Só leitura: GET no Superlógica (CNPJ dos condomínios) e, com --interna, a leitura interna dos
// escaneados. Compara tipo, valor, vencimento e condomínio pelo CNPJ com a despesa lançada.
// Uso: railway run ... node scripts/entrada-amostra.js --pasta <T32> --n 50 [--escaneados 10] [--interna] --saida <arquivo.json>
const fs = require('fs');
const path = require('path');
const E = require('../financeiro/entrada');
const sl = require('../superlogica');

const arg = (k, p) => { const i = process.argv.indexOf('--' + k); return i > 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : p; };
const pasta = arg('pasta');
const N = Number(arg('n', 50));
const NESC = Number(arg('escaneados', 10));
const interna = !!arg('interna', false);
const saida = arg('saida', 'entrada-amostra.json');
if (!pasta) { console.error('use --pasta'); process.exit(1); }

const anexos = JSON.parse(fs.readFileSync(path.join(pasta, 'anexos.json')));
const despesas = JSON.parse(fs.readFileSync(path.join(pasta, 'despesas.json')));
const porDespesa = new Map();
(Array.isArray(despesas) ? despesas : []).forEach((d) => { const k = String(d.id_despesa_des); if (!porDespesa.has(k)) porDespesa.set(k, []); porDespesa.get(k).push(d); });

// Amostra fixa: boletos e notas, uma por despesa, alternando condomínios; escaneados à parte.
function amostra() {
  // Fora: folha e adiantamento (não são documentos de entrada) e despesas com mais de um anexo
  // da mesma etiqueta (parcelada: o boleto pode ser de outra parcela).
  const cont = {};
  anexos.forEach((a) => { const k = a.idDespesa + ':' + a.etiqueta; cont[k] = (cont[k] || 0) + 1; });
  const cand = anexos.filter((a) => ['Doc. Pgto', 'Doc. Fiscal'].includes(a.etiqueta) && a.download && a.download.ok &&
    !/folha|adiantamento|sal[aá]rio|f[eé]rias|rescis/i.test(a.fornecedor || '') && cont[a.idDespesa + ':' + a.etiqueta] === 1 && (porDespesa.get(String(a.idDespesa)) || []).length === 1);
  const vistos = new Set();
  const porCond = {};
  cand.forEach((a) => { (porCond[a.idCond] = porCond[a.idCond] || []).push(a); });
  const conds = Object.keys(porCond).sort();
  const texto = [], esc = [];
  let i = 0, rodada = 0;
  while ((texto.length < N - NESC || esc.length < NESC) && rodada < 400) {
    const c = conds[i % conds.length];
    const l = porCond[c];
    const a = l[rodada % l.length];
    i++; if (i % conds.length === 0) rodada++;
    const k = a.idDespesa + ':' + a.etiqueta;
    if (vistos.has(k) || vistos.has(a.idArquivo)) continue;
    const leg = a.resultado && a.resultado.legivel;
    if (leg && texto.length < N - NESC) { texto.push(a); vistos.add(k); vistos.add(a.idArquivo); }
    else if (!leg && esc.length < NESC) { esc.push(a); vistos.add(k); vistos.add(a.idArquivo); }
  }
  return texto.concat(esc);
}

(async () => {
  const cli = sl.cliente({ base: process.env.SUPERLOGICA_API_BASE || 'https://api.superlogica.net', appToken: process.env.SUPERLOGICA_APP_TOKEN, accessToken: process.env.SUPERLOGICA_ACCESS_TOKEN });
  const mapa = await E.mapaCondominios(cli);
  const processar = interna ? require('../servico/processar') : null;
  const lista = amostra();
  const res = [];
  // Respostas da leitura interna guardadas para rodar de novo sem repetir (fora do git).
  const arqCache = arg('cache', null);
  const cacheInterna = arqCache && fs.existsSync(arqCache) ? JSON.parse(fs.readFileSync(arqCache)) : {};
  for (const a of lista) {
    const arq = path.join(pasta, 'anexos', a.idCond + '_' + a.idDespesa + '_' + a.idArquivo + '.pdf');
    const buf = fs.readFileSync(arq);
    // Mesma decisão da rota: texto primeiro; leitura interna quando falta o essencial.
    const x = await E.extrairTexto(buf);
    const util = !!(x && E.textoUtil(x.texto));
    let campos = util ? E.lerCampos(x.texto, '2026-10-21') : null;
    let leitura = util ? 'texto' : 'sem_texto';
    if (E.faltaEssencial(campos, mapa) && processar && buf.length <= 7.5 * 1024 * 1024) {
      const ck = path.basename(arq);
      const r = cacheInterna[ck] || await processar.processarDocumentoFinanceiro({ arquivo: { mime: 'application/pdf', base64: buf.toString('base64') } }, 'teste-t33');
      if (r.status === 200) cacheInterna[ck] = r;
      const ci = r.status === 200 ? E.camposDaLeitura(r.corpo, '2026-10-21') : null;
      const preferir = !campos || !campos.cnpjs.some((c) => mapa.has(c.cnpj));
      if (ci) { campos = E.juntarLeituras(campos, ci, preferir); leitura = util ? 'texto+interna' : 'interna'; } else leitura += '+interna_falhou';
    }
    const parcelas = porDespesa.get(String(a.idDespesa)) || [];
    const p = parcelas[0] || {};
    const valorDesp = Number(a.valor);
    const vencs = parcelas.map((q) => E.slParaIso(q.dt_vencimento_pdes)).filter(Boolean);
    const esperadoTipo = a.etiqueta === 'Doc. Fiscal' ? ['nota', 'guia'] : ['boleto', 'fatura', 'guia'];
    // Condomínio como a rota escolhe: único CNPJ de condomínio, ou o único com papel de pagador.
    let condEscolhido = null;
    if (campos) {
      const cs = campos.cnpjs.filter((c) => mapa.has(c.cnpj));
      const ids = [...new Set(cs.map((c) => mapa.get(c.cnpj).id))];
      if (ids.length === 1) condEscolhido = ids[0];
      else if (ids.length > 1) { const pg = [...new Set(cs.filter((c) => c.papel === 'pagador').map((c) => mapa.get(c.cnpj).id))]; if (pg.length === 1) condEscolhido = pg[0]; }
    }
    const temVenc = !!(campos && campos.vencimento);
    // Valor lido diferente do lançado: parcela (o lido é múltiplo inteiro do lançado) ou retenção
    // (boleto ou nota com valor líquido até 8% abaixo do lançado).
    let divergencia = null;
    if (campos && campos.valor && Math.abs(campos.valor - valorDesp) >= 0.005 && valorDesp > 0) {
      const k = campos.valor / valorDesp;
      if (k > 1.5 && Math.abs(k - Math.round(k)) < 0.01) divergencia = 'parcelado_' + Math.round(k) + 'x';
      else if (k < 1 && k >= 0.92) divergencia = 'retencao_ou_juros';
      else divergencia = 'sem_explicacao';
    }
    res.push({
      arquivo: path.basename(arq), condominio: a.condominio, idCond: a.idCond, despesa: a.idDespesa, fornecedor: a.fornecedor, etiqueta: a.etiqueta, leitura,
      lido: campos ? { tipo: campos.tipo, valor: campos.valor, origem: campos.origem_valor, vencimento: campos.vencimento, documento: campos.documento, linha: !!campos.linha, cnpjs: campos.cnpjs.map((c) => c.cnpj + ':' + c.papel) } : null,
      despesa_lancada: { valor: valorDesp, vencimentos: vencs, documento: p.st_documento_des || null, parcelas: parcelas.length },
      certo: {
        tipo: !!campos && esperadoTipo.includes(campos.tipo),
        valor: !!campos && campos.valor != null && Math.abs(campos.valor - valorDesp) < 0.005,
        vencimento: temVenc ? vencs.includes(campos.vencimento) : null, // null = documento sem vencimento (nota)
        venc3: temVenc ? vencs.some((v) => Math.abs(Date.parse(v) - Date.parse(campos.vencimento)) <= 3 * 86400000) : null,
        cnpj: condEscolhido === String(a.idCond),
      },
      divergencia_valor: divergencia,
    });
    process.stdout.write('.');
  }
  const conta = (k, filtro) => { const l = res.filter(filtro || (() => true)); const ok = l.filter((r) => r.certo[k] === true).length; return { ok, total: l.length, pct: l.length ? Math.round(1000 * ok / l.length) / 10 : 0 }; };
  const resumo = {
    total: res.length, por_leitura: res.reduce((m, r) => { m[r.leitura] = (m[r.leitura] || 0) + 1; return m; }, {}),
    tipo: conta('tipo'), valor: conta('valor'), cnpj_condominio: conta('cnpj'),
    vencimento_quando_lido: conta('vencimento', (r) => r.certo.vencimento !== null),
    vencimento_boletos: conta('vencimento', (r) => r.etiqueta === 'Doc. Pgto'),
    valor_boletos: conta('valor', (r) => r.etiqueta === 'Doc. Pgto'), valor_notas: conta('valor', (r) => r.etiqueta === 'Doc. Fiscal'),
    escaneados: { tipo: conta('tipo', (r) => r.leitura.startsWith('interna')), valor: conta('valor', (r) => r.leitura.startsWith('interna')), cnpj: conta('cnpj', (r) => r.leitura.startsWith('interna')) },
  };
  resumo.divergencias_valor = res.reduce((m, r) => { if (r.divergencia_valor) m[r.divergencia_valor.replace(/_\d+x$/, '')] = (m[r.divergencia_valor.replace(/_\d+x$/, '')] || 0) + 1; return m; }, {});
  resumo.valor_lido_ou_explicado = conta('valor', () => true);
  resumo.valor_lido_ou_explicado.ok += res.filter((r) => r.divergencia_valor && r.divergencia_valor !== 'sem_explicacao').length;
  resumo.valor_lido_ou_explicado.pct = Math.round(1000 * resumo.valor_lido_ou_explicado.ok / res.length) / 10;
  resumo.vencimento_ate_3_dias = conta('venc3', (r) => r.certo.vencimento !== null);
  if (arqCache) fs.writeFileSync(arqCache, JSON.stringify(cacheInterna));
  fs.writeFileSync(saida, JSON.stringify({ resumo, itens: res }, null, 1));
  console.log('\n' + JSON.stringify(resumo, null, 1));
})().catch((e) => { console.error('ERRO', e && e.message); process.exit(1); });
