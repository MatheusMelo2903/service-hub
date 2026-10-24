'use strict';
// Testes do balancete digital feito pelo sistema (financeiro/balancete-digital.js e
// financeiro/balancete-digital-rotas.js) com o Superlógica DUBLADO: nenhuma chamada sai da máquina
// (https.request é trocado por um dublê antes de carregar os módulos). Rodar:
//   NODE_PATH=/home/claude/service-hub/node_modules NODE_ENV=test node scripts/teste-balancete-digital.js
process.env.NODE_ENV = 'test';
process.env.BALANCETE_SELECAO = 'condominio:4'; // sem ajuste da seleção pessoal no teste
const https = require('https');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const http = require('http');

// ── Superlógica dublado ──────────────────────────────────────────────────
const SL = { chamadas: [], comentarios: [], arquivos: new Map(), proximoArq: 900001, proximoCom: 50001, fechamento: '01/01/1899', falhar: {}, semResposta: {} };
function pdf(txt) { return Buffer.from('%PDF-1.4\n' + (txt || 'x') + '\n%%EOF\n', 'latin1'); }
function campos(corpo, tipo) {
  if (!corpo || !corpo.length) return {};
  const s = corpo.toString('latin1');
  if (/multipart/.test(tipo || '')) {
    const o = {};
    s.split(/--+hub[0-9a-f]+/).forEach((p) => { const m = /name="([^"]+)"(?:; filename="[^"]*")?[^\r\n]*\r\n(?:Content-Type:[^\r\n]*\r\n)?\r\n([\s\S]*?)\r\n$/.exec(p); if (m) o[m[1]] = m[1] === 'ARQUIVO[]' ? '(arquivo ' + m[2].length + ' bytes)' : m[2]; });
    return o;
  }
  return Object.fromEntries(new URLSearchParams(corpo.toString('utf8')));
}
function responder(metodo, url, f) {
  const p = url.pathname.replace('/v2/condor/', '');
  const q = Object.fromEntries(url.searchParams);
  SL.chamadas.push({ metodo, rota: p, q, f });
  const ok = (data, msg) => ({ status: 200, json: [{ status: '200', msg: msg || 'Sucesso', data }] });
  if (SL.semResposta[p]) return { status: 504, json: null };
  if (SL.falhar[p]) return { status: 206, json: [{ status: '500', msg: SL.falhar[p] }] };
  if (p === 'arquivos/put') { const id = SL.proximoArq++; SL.arquivos.set(String(id), { etiqueta: f.ID_ETIQUETA_ETI || null }); return ok({ id_arquivo_arq: String(id), st_hash_arq: 'h' + id }); }
  if (p === 'arquivos/adicionaretiqueta') { const a = SL.arquivos.get(String(q.idDocumento)); if (a && a.etiqueta) return { status: 206, json: [{ status: '500', msg: 'Essa etiqueta já está adicionada ao arquivo.' }] }; if (a) a.etiqueta = q.idEtiqueta; return { status: 200, json: [{ status: '200', msg: 'Etiqueta adicionada com sucesso' }] }; }
  if (p === 'arquivos/delete') { SL.arquivos.delete(String(q.ID_ARQUIVO_ARQ)); return ok({}); }
  if (p === 'comentarios/putarquivos') return ok({ ids_arquivos: [f['ARQUIVOS[0][ID_ARQUIVO_ARQ]']] });
  if (p === 'comentarios/put') {
    const id = SL.proximoCom++;
    const ref = f.DT_REFERENCIA.slice(6) + f.DT_REFERENCIA.slice(0, 2);
    // Formato real (167): o título enviado não fica; o nome do comentário é o texto.
    const ident = f.TIPO_OBJETO === 'FERRAMENTA' ? f.ID_CONDOMINIO + '_' + f.ID_OBJETO + '/' + ref : f.ID_CONDOMINIO + '_' + f.ID_PLANOCONTA + '_' + f.ID_OBJETO + '/' + ref;
    const arqs = Object.keys(f).filter((k) => /^ARQUIVOS\[\d+\]\[ID_ARQUIVO_ARQ\]$/.test(k)).map((k) => f[k]);
    SL.comentarios.push({ id_comentarioconteudo_comc: String(id), st_texto_comc: f.TEXTO, fl_visibilidade_comc: f.VISIBILIDADE, st_identificadororigem_como: ident, _tipo: f.TIPO_OBJETO,
      arquivos: arqs.map((x) => ({ id_arquivo_arq: x, st_nome_arq: 'x', st_extensao_arq: 'pdf', st_nomeetiqueta_eti: 'Extrato', etiquetas: [{ id_etiqueta_eti: String((SL.arquivos.get(x) || {}).etiqueta || ''), st_nomeabreviadoetiqueta_eti: '' }] })) });
    if (SL.engolirComentario) SL.comentarios.pop();
    return ok({ id_comentarioconteudo_comc: String(id) });
  }
  if (p === 'condominios/fecharmes') { SL.fechamento = f.DT_FECHAMENTO; return ok({ idcondominio: f.ID_CONDOMINIO_COND }, 'Sucesso'); }
  if (p === 'impressoes/delete') { SL.impressoesApagadas = (SL.impressoesApagadas || 0) + 1; return ok({}); }
  if (/^relatorios\/id\//.test(p)) return { status: 200, json: [{ status: '200', id_impressao: String(700000 + SL.chamadas.length) }] };
  return { status: 404, json: null };
}
https.request = function (opcoes, cb) {
  const req = new EventEmitter();
  const partes = [];
  req.setTimeout = () => req; req.destroy = () => {}; req.write = (c) => partes.push(Buffer.from(c));
  req.end = (dados) => {
    if (dados) partes.push(Buffer.isBuffer(dados) ? dados : Buffer.from(dados));
    if (opcoes.hostname !== 'api.superlogica.net' && !/superlogica/.test(opcoes.hostname)) throw new Error('chamada para fora no teste: ' + opcoes.hostname);
    const url = new URL('https://' + opcoes.hostname + opcoes.path);
    setImmediate(() => {
      let resp;
      if (/documentos\/download/.test(url.pathname)) { resp = Readable.from([pdf('relatorio ' + url.searchParams.get('id'))]); resp.statusCode = 200; resp.headers = {}; }
      else {
        const r = responder(opcoes.method, url, campos(Buffer.concat(partes), opcoes.headers['content-type']));
        resp = Readable.from([Buffer.from(r.json ? JSON.stringify(r.json) : 'Gateway Timeout')]);
        resp.statusCode = r.status; resp.headers = {};
      }
      cb(resp);
    });
  };
  return req;
};
// Cliente de leitura dublado (cliente.get).
const cliente = {
  async get(rota, q) {
    SL.chamadas.push({ metodo: 'GET', rota, q, leitura: true });
    if (rota === 'comentarios/index') {
      const ref = q.DT_REFERENCIA.slice(6) + q.DT_REFERENCIA.slice(0, 2);
      // Formato conferido no 167: conta obrigatória e resposta embrulhada.
      if (!q.ID_OBJETO || !q.TIPO_OBJETO) return [{ status: '500', msg: 'Identificador de objeto não informado.' }];
      // Balão do Demonstrativo R&D (FERRAMENTA/DIAGNOSTICO): identificador "<cond>_DIAGNOSTICO/AAAAMM" (formato real, 24/10/2026).
      return [{ status: '200', data: SL.comentarios.filter((c) => {
        const f = /^(\d+)_DIAGNOSTICO\/(\d{6})$/.exec(c.st_identificadororigem_como);
        if (f) return q.TIPO_OBJETO === 'FERRAMENTA' && q.ID_OBJETO === 'DIAGNOSTICO' && f[1] === String(q.ID_CONDOMINIO) && f[2] === ref;
        const m = /^(\d+)_(\d+)_([\d.]+)\/(\d{6})$/.exec(c.st_identificadororigem_como); return q.TIPO_OBJETO === 'CONTACATEGORIA' && m && m[1] === String(q.ID_CONDOMINIO) && m[4] === ref && m[3] === q.ID_OBJETO; }) }];
    }
    if (rota === 'condominios/get') return [{ id_condominio_cond: String(q.id), st_fantasia_cond: 'Residencial Teste', dt_fechamento_cond: SL.fechamento }];
    if (rota === 'arquivos/etiquetas') return [{ id_etiqueta_eti: '8', st_nomeetiqueta_eti: 'Extrato' }, { id_etiqueta_eti: '4', st_nomeetiqueta_eti: 'Orçamento' }, { id_etiqueta_eti: '9', st_nomeetiqueta_eti: 'Consumo' }];
    if (rota === 'impressoes/index') return [];
    if (rota === 'caixa/index') return [{ saldoinicialconta: q.dtInicio === '09/01/2026' ? '1000.00' : '1100.00' }];
    if (rota === 'balancetes/index') return [{ itens: [[{ conta: '1', descricao: 'Receitas', valor: '500.00' }, { conta: '1.1', descricao: 'Taxa', valor: '500.00' }, { conta: '1.2', descricao: 'Outras', valor: '0' }, { conta: '1.3', descricao: 'Fundo', valor: '0' }, { conta: '2', descricao: 'Despesas', valor: '-400.00' }]] }];
    return [];
  },
};

const D = require('../financeiro/balancete-digital');
const W = require('../servico/escrita-superlogica');
let falhas = 0, total = 0;
function t(nome, cond, extra) { total++; if (!cond) { falhas++; console.log('FALHOU: ' + nome + (extra ? ' ' + JSON.stringify(extra) : '')); } else console.log('ok: ' + nome); }
const cred = { base: 'https://api.superlogica.net', appToken: 'x', accessToken: 'y' };
const escritas = () => SL.chamadas.filter((c) => !c.leitura && !/^relatorios\//.test(c.rota));
function comentarioAntigo(mes, conta, titulo, etq, plano) {
  const ref = mes.replace('-', '');
  SL.comentarios.push({ id_comentarioconteudo_comc: String(SL.proximoCom++), st_texto_comc: titulo, fl_visibilidade_comc: '0', st_identificadororigem_como: '167_' + (plano || '17') + '_' + conta + '/' + ref,
    arquivos: [{ id_arquivo_arq: String(SL.proximoArq++), st_nome_arq: 'a', st_extensao_arq: 'pdf', etiquetas: [{ id_etiqueta_eti: String(etq), st_nome_eti: etq === 8 ? 'Extrato' : 'Orçamento' }] }] });
}

(async () => {
  // ── funções puras ──
  t('título sem mês', D.chaveTitulo('Extrato Conta Corrente 09/2026') === D.chaveTitulo('extrato conta corrente set/2026'));
  t('74A vira relatório', D.classificarDocumento('Simulação 74A').codigo === '074A');
  t('11A vira relatório', D.classificarDocumento('11A anual').codigo === '011A');
  t('poupança é documento que precisa chegar', D.classificarDocumento('Extratos poupanças').grupo === 'extrato_poupanca');
  t('garantidora diz quem age', /Garantidora/.test(D.classificarDocumento('Relatório garantidora').quem));
  t('capa o Hub monta', D.classificarDocumento('Capa').tipo === 'capa');
  const capa = D.montarCapa('Residencial Teste', '2026-09');
  t('capa é PDF', D.ehPdf(capa) && /%%EOF/.test(capa.toString('latin1')) && /Setembro de 2026/.test(capa.toString('latin1')));
  t('competências do dia 1', JSON.stringify(D.competenciasDoDia('2026-10-01')) === JSON.stringify([{ comp: '2026-09', montar: true }]));
  t('último dia do mês acompanha o próprio mês', D.competenciasDoDia('2026-10-31').some((x) => x.comp === '2026-10' && !x.montar));
  t('dia 20 não trabalha', D.competenciasDoDia('2026-10-20').length === 0);
  t('reabrir volta para antes do Hub fechar (nunca fechado)', D.dataReabertura('2026-09', '') === '');
  t('reabrir sem registro: fim do mês anterior', D.dataReabertura('2026-09', undefined) === '2026-08-31');
  t('reabrir ignora data anterior dentro do mês', D.dataReabertura('2026-09', '2026-09-15') === '2026-08-31');
  t('soma bate', D.montarSoma({ saldo_inicial: 1000, receitas: 500, despesas: -400, saldo_final_caixa: 1100 }).ok === true);
  const sm = D.montarSoma({ saldo_inicial: 1000, receitas: 500, despesas: -400, saldo_final_caixa: 1090 });
  t('soma não bate mostra a diferença', sm.ok === false && sm.diferenca === -10);
  t('trava de condomínio', (() => { try { D.conferirCampos('167', { ID_CONDOMINIO_COND: '167', 'CONDOMINIOS_E_GRUPOS[1][ID_CONDOMINIO_COND]': '136' }); return false; } catch (e) { return e.codigo === 'trava_condominio'; } })());
  t('título do modelo sem hífen', D.validarModelo([{ titulo: 'Extrato - conta corrente', conta: '1.1' }]).itens[0].titulo === 'Extrato conta corrente');
  t('soma em reais no formato brasileiro', /R\$ 1\.000,00/.test(D.montarSituacao({ comp: '2026-09', hoje: '2026-10-01', soma: D.montarSoma({ saldo_inicial: 1000, receitas: 500, despesas: -400, saldo_final_caixa: 1090 }), fechadoAte: '' }).travas.map((x) => x.causa).join(' ')));
  t('modelo inválido recusado', !!D.validarModelo([{ titulo: 'Extrato', conta: 'abc' }]).erro);
  t('modelo repetido recusado', !!D.validarModelo([{ titulo: 'Extrato', conta: '1.1' }, { titulo: 'Extrato', conta: '1.1' }]).erro);
  const pz = (h) => D.prazo(D.competencia('2026-09'), h, 'montagem').situacao;
  t('prazo: em dia, passou do ideal, atrasado', pz('2026-09-30') === 'em_dia' && pz('2026-10-03') === 'passou_ideal' && pz('2026-10-06') === 'atrasado');
  t('política tem as 3 operações novas sensíveis', ['balancete_montar', 'mes_fechar', 'mes_reabrir'].every((k) => W.OPERACOES[k] && W.OPERACOES[k].sensivel));
  t('política: livre no 167, bloqueado no 136 no modo teste', W.situacao('mes_fechar', '167', null, {}).estado === 'livre' && W.situacao('mes_fechar', '136', null, {}).estado === 'bloqueado');
  t('política: reforçada no 136 no modo confirmação', W.situacao('balancete_montar', '136', null, { ESCRITA_SUPERLOGICA: 'confirmacao' }).estado === 'reforcada');

  // ── aprender o modelo ──
  ['2026-07', '2026-08', '2026-09'].forEach((m) => {
    comentarioAntigo(m, '1.1', 'Capa ' + m.slice(5) + '/' + m.slice(0, 4), 4);
    comentarioAntigo(m, '1.1', 'Simulação 74A', 4);
    comentarioAntigo(m, '1.2', 'Extrato conta corrente ' + m.slice(5) + '/2026', 8);
  });
  comentarioAntigo('2026-09', '1.2', 'Certidões', 4);
  const porMes = {};
  for (const m of ['2026-07', '2026-08', '2026-09']) { porMes[m] = []; for (const conta of ['1.1', '1.2']) porMes[m] = porMes[m].concat(await D.comentariosDoMes(cliente, '167', m, conta)); }
  t('listagem sem conta lê o balão do Demonstrativo R&D', (await D.comentariosDoMes(cliente, '167', '2026-09', null)).length === 0 && SL.chamadas.some((c) => c.rota === 'comentarios/index' && c.q.TIPO_OBJETO === 'FERRAMENTA' && c.q.ID_OBJETO === 'DIAGNOSTICO'));
  const mdl = D.aprenderModelo(porMes, {});
  t('aprende 3 comentários frequentes', mdl.itens.length === 3, mdl.itens.map((i) => i.titulo));
  t('certidões ficam como às vezes', mdl.as_vezes.length === 1 && /Certid/.test(mdl.as_vezes[0].titulo));
  t('aprende o plano de contas', mdl.plano === '17');
  t('aprende conta e etiqueta', mdl.itens.find((i) => /Extrato/.test(i.titulo)).conta === '1.2' && mdl.itens.find((i) => /Extrato/.test(i.titulo)).etiqueta_id === 8);
  t('ordem segue a do R&D', mdl.itens[0].fonte.tipo === 'capa' && mdl.itens[2].fonte.grupo === 'extrato_conta');
  const val = D.validarModelo(mdl.itens);
  t('modelo aprendido é válido', !val.erro && val.itens.length === 3, val);

  // ── gravar um comentário com anexo (caminho feliz) ──
  const ctx = { cred, cliente, idCond: '167', plano: '17', comp: '2026-10' };
  const item = { chave: 'extrato_conta_corrente', titulo: 'Extrato conta corrente', conta: '1.2', etiqueta_id: 8 };
  SL.chamadas = [];
  const r1 = await D.gravarComentario(ctx, item, { buffer: pdf('extrato'), nome: 'extrato.pdf' });
  const seq = escritas().map((c) => c.rota);
  t('grava e confere', r1.estado === 'gravado' && /^\d+$/.test(r1.id_comentario), r1);
  t('sequência testada no 167', JSON.stringify(seq) === JSON.stringify(['arquivos/put', 'arquivos/adicionaretiqueta', 'comentarios/putarquivos', 'comentarios/put']), seq);
  const put = SL.chamadas.find((c) => c.rota === 'comentarios/put').f;
  const arq = SL.chamadas.find((c) => c.rota === 'arquivos/put').f;
  t('VISIBILIDADE=0 explícito', put.VISIBILIDADE === '0' && put.TIPO_OBJETO === 'CONTACATEGORIA' && put.ID_OBJETO === '1.2' && put.ID_PLANOCONTA === '17');
  t('data MM/DD/AAAA', put.DT_REFERENCIA === '10/01/2026');
  t('anexo com ID_RESPONSAVEL_ARQ do condomínio', arq.ID_RESPONSAVEL_ARQ === '167' && arq.FL_TIPO_ARQ === '15' && arq.ID_FERRAMENTA_ARF === '7');
  t('etiqueta aplicada', SL.arquivos.get(r1.id_arquivo).etiqueta === '8' || SL.arquivos.get(r1.id_arquivo).etiqueta === 8);
  t('relê antes de gravar', SL.chamadas[0].rota === 'comentarios/index');

  // ── já existia: não grava de novo ──
  SL.chamadas = [];
  const r2 = await D.gravarComentario(ctx, item, { buffer: pdf('extrato'), nome: 'extrato.pdf' });
  t('já existia: nenhuma gravação', r2.estado === 'ja_existia' && escritas().length === 0, r2);

  // ── falha no comentário: apaga o anexo ──
  SL.chamadas = []; SL.falhar['comentarios/put'] = 'Erro de regra';
  const antesArq = SL.arquivos.size;
  const r3 = await D.gravarComentario(ctx, { chave: 'outro', titulo: 'Relatório garantidora', conta: '1.3', etiqueta_id: 4 }, { buffer: pdf('g'), nome: 'g.pdf' });
  delete SL.falhar['comentarios/put'];
  t('falha apaga o anexo (sem sobra)', r3.estado === 'falhou' && SL.arquivos.size === antesArq && escritas().some((c) => c.rota === 'arquivos/delete'), r3);

  // ── sem resposta: incerto, sem repetir ──
  SL.chamadas = []; SL.semResposta['comentarios/put'] = true;
  const r4 = await D.gravarComentario(ctx, { chave: 'f', titulo: 'Francesinha', conta: '1.3', etiqueta_id: 4 }, { buffer: pdf('f'), nome: 'f.pdf' });
  delete SL.semResposta['comentarios/put'];
  t('sem resposta vira incerto e não repete', r4.estado === 'incerto' && escritas().filter((c) => c.rota === 'comentarios/put').length === 1, r4);

  // ── incerto no agendamento: só relê, não grava de novo ──
  SL.chamadas = [];
  const r4b = await D.gravarComentario(ctx, { chave: 'f', titulo: 'Francesinha', conta: '1.3', etiqueta_id: 4 }, { buffer: pdf('f'), nome: 'f.pdf' }, { soReler: true });
  t('incerto no agendamento só relê', r4b.estado === 'incerto' && escritas().length === 0, r4b);
  t('lê o comentário real (nome no texto, etiqueta no anexo)', (() => { const x = D.lerComentario({ id_comentarioconteudo_comc: '12329', st_texto_comc: 'TESTE HUB 10/2026', fl_visibilidade_comc: '0', st_identificadororigem_como: '167_17_2.2.1/202610', arquivos: [{ id_arquivo_arq: '659088', st_nomeetiqueta_eti: 'Extrato', etiquetas: [{ id_etiqueta_eti: '8', st_nomeabreviadoetiqueta_eti: '' }] }] });
    return x.id === '12329' && x.titulo === 'TESTE HUB 10/2026' && x.conta === '2.2.1' && x.plano === '17' && x.referencia === '2026-10' && x.visibilidade === 0 && x.arquivos[0].etiqueta_id === 8 && x.arquivos[0].etiqueta_nome === 'Extrato'; })());
  // ── não é PDF ──
  const r5 = await D.gravarComentario(ctx, { chave: 'z', titulo: 'Zzz', conta: '1.3' }, { buffer: Buffer.from('oi'), nome: 'z.txt' });
  t('recusa arquivo que não é PDF', r5.estado === 'falhou');
  t('recusa condomínio da administração', await D.gravarComentario(Object.assign({}, ctx, { idCond: '143' }), item, { buffer: pdf() }).then(() => false, (e) => e.codigo === 'trava_condominio'));

  // ── fechamento ──
  SL.chamadas = [];
  const f1 = await D.gravarFechamento({ cred, cliente, idCond: '167', nome: 'Residencial Teste' }, '2026-09-30');
  const fm = SL.chamadas.find((c) => c.rota === 'condominios/fecharmes').f;
  t('fecha e relê', f1.ok && SL.fechamento === '09/30/2026', f1);
  t('fecharmes só com o próprio condomínio', fm['CONDOMINIOS_E_GRUPOS[0][ID_CONDOMINIO_COND]'] === '167' && !Object.keys(fm).some((k) => /\[1\]/.test(k)) && fm.ID_CONDOMINIO_COND === '167');
  const f2 = await D.gravarFechamento({ cred, cliente, idCond: '167', nome: 'Residencial Teste' }, '');
  t('reabre com 01/01/1899, nunca vazio', f2.ok && SL.fechamento === '01/01/1899');

  // ── situação ──
  const fechT = { pronto: false, nome: 'Residencial Teste', falta: ['x'], itens: [
    { chave: 'conciliacao', situacao: 'ok' }, { chave: 'extrato', situacao: 'pendente', trava: 'conta Poupança: extrato só até 20/09/2026.' },
    { chave: 'pre_balancete', situacao: 'pendente', trava: '1 pagas sem comprovante' }, { chave: 'boletos', situacao: 'ok' }, { chave: 'anexos', situacao: 'ok' }] };
  const preT = { pendencias: 1, grupos: [{ chave: 'sem_comprovante', itens: [{ gravidade: 'alta', fornecedor: 'EDP', valor: 140.97 }] }] };
  const s1 = D.montarSituacao({ comp: '2026-09', hoje: '2026-10-03', fechamento: fechT, pre: preT, soma: sm, modelo: { plano: '17', itens: val.itens }, documentos: new Set(), montagem: {}, gravacao: 'livre', fechadoAte: '', impressoes: [] });
  t('etapa é a primeira que trava (extrato)', s1.etapa === 'extrato', s1.etapa);
  t('causa do extrato e quem age', s1.travas.some((x) => /Extrato não chegou: conta Poupança/.test(x.causa) && /Financeiro/.test(x.quem)));
  t('nota da EDP sem comprovante', s1.travas.some((x) => /sem comprovante: EDP R\$ 140,97/.test(x.causa) && /anexar o comprovante/.test(x.quem)));
  t('extrato do banco não chegou para o comentário', s1.travas.some((x) => /Extrato da conta corrente, do banco não chegou/.test(x.causa)));
  t('soma que não bate trava', s1.travas.some((x) => /não bate com o caixa/.test(x.causa)));
  t('fechamento a confirmar pela pessoa', s1.travas.some((x) => /Fechamento do mês não confirmado/.test(x.causa) && /Pessoa/.test(x.quem)));
  t('prazo passou do ideal no dia 3', s1.prazo.situacao === 'passou_ideal');
  const tudoOk = { pronto: true, itens: ['conciliacao', 'extrato', 'pre_balancete', 'boletos', 'anexos'].map((k) => ({ chave: k, situacao: 'ok' })) };
  const mont = {}; val.itens.forEach((i) => { mont[i.chave] = { estado: 'gravado' }; });
  const s2 = D.montarSituacao({ comp: '2026-09', hoje: '2026-09-30', fechamento: tudoOk, soma: { ok: true }, modelo: { plano: '17', itens: val.itens }, documentos: new Set(), montagem: mont, fechadoAte: '2026-09-30', impressoes: [{ id: '1', da_competencia: true, publicado: false }], conferencia: { ok: true, problemas: 0 } });
  t('tudo certo: pronto para publicar', s2.etapa === 'pronto_publicar' && !s2.travas.length, s2.travas);
  const s3 = D.montarSituacao({ comp: '2026-09', hoje: '2026-10-01', fechamento: tudoOk, soma: { ok: true }, modelo: { plano: '17', itens: val.itens }, documentos: new Set(), montagem: mont, fechadoAte: '2026-09-30', impressoes: [{ id: '1', da_competencia: true, publicado: false }], conferencia: { ok: false, problemas: 2 } });
  t('conferência final com pontos marcados', s3.etapa === 'conferencia' && /2 ponto/.test(s3.travas[0].causa));
  const s4 = D.montarSituacao({ comp: '2026-09', hoje: '2026-10-01', fechamento: tudoOk, modelo: { plano: '17', itens: val.itens }, montagem: {}, documentos: new Set(), gravacao: 'reforcada', fechadoAte: '2026-09-30', impressoes: [] });
  t('fora do teste: quem confirma a gravação', s4.travas.some((x) => /confirmar a gravação/.test(x.quem)));

  // ── formato real da equipe (Buritis e Victoria Bay, 24/10/2026): balão do Demonstrativo R&D ──
  const real = (mes, id, texto, arquivos) => SL.comentarios.push({ id_comentarioconteudo_comc: String(id), st_texto_comc: texto, fl_visibilidade_comc: '1', st_identificadororigem_como: '167_DIAGNOSTICO/' + mes.replace('-', ''),
    arquivos: arquivos.map(([ida, nome, etq, etqNome]) => ({ id_arquivo_arq: String(ida), st_nome_arq: nome, st_extensao_arq: 'pdf', st_nomeetiqueta_eti: etqNome, etiquetas: [{ id_etiqueta_eti: String(etq), st_nomeabreviadoetiqueta_eti: '' }] })) });
  let k = 80000;
  ['2026-05', '2026-06', '2026-07'].forEach((m) => {
    real(m, k++, 'Capa', [[k, 'capa', 26, 'Jurídico']]); real(m, k++, 'Relatorio 11A', [[k, '011A', 5, 'Contrato']]); real(m, k++, 'Extrato conta corrente', [[k, 'cc', 8, 'Extrato']]);
    real(m, k++, 'Extratos poupanças', [[k, 'Movimentações bancárias Fundo', 6, 'Orçamento'], [k + 1000, 'R$ 7.372,55', 6, 'Orçamento'], [k + 2000, 'P. energia', 6, 'Orçamento']]);
    real(m, k++, 'Pjbank', [[k, 'Pjbank', 7, 'Comunicado']]); real(m, k++, 'Simulação', [[k, '074A', 9, 'Consumo']]);
  });
  const pm = {}; for (const m of ['2026-05', '2026-06', '2026-07']) pm[m] = await D.comentariosDoMes(cliente, '167', m, null);
  const mreal = D.aprenderModelo(pm, {});
  t('real: aprende os 6 do balão do R&D na ordem da equipe', mreal.itens.map((i) => i.titulo).join('|') === 'Capa|Relatorio 11A|Extrato conta corrente|Extratos poupanças|Pjbank|Simulação', mreal.itens.map((i) => i.titulo));
  t('real: lugar DIAGNOSTICO e etiquetas trocadas (Capa em Jurídico, Simulação em Consumo)', mreal.itens.every((i) => i.conta === 'DIAGNOSTICO') && mreal.itens[0].etiqueta_id === 26 && mreal.itens[5].etiqueta_id === 9 && mreal.itens[3].etiqueta_nome === 'Orçamento');
  t('real: poupanças com 3 anexos por mês', mreal.itens[3].anexos_por_mes === 3);
  t('real: avisa que a equipe deixa visível', mreal.visibilidade_equipe === 1 && mreal.avisos.some((x) => /visíveis/.test(x)));
  t('real: modelo com DIAGNOSTICO é válido', !D.validarModelo(mreal.itens).erro);
  SL.chamadas = [];
  const ctxR = { cred, cliente, idCond: '167', plano: '17', comp: '2026-08' };
  const rr = await D.gravarComentario(ctxR, mreal.itens[3], [{ buffer: pdf('a'), nome: 'Movimentações Fundo.pdf' }, { buffer: pdf('b'), nome: 'R$ 7.372,55.pdf' }]);
  const putR = SL.chamadas.find((c) => c.rota === 'comentarios/put').f;
  t('real: grava no balão do R&D (FERRAMENTA/DIAGNOSTICO) com o nome da equipe', rr.estado === 'gravado' && putR.TIPO_OBJETO === 'FERRAMENTA' && putR.ID_OBJETO === 'DIAGNOSTICO' && putR.TEXTO === 'Extratos poupanças' && putR.VISIBILIDADE === '0', rr);
  t('real: dois anexos no mesmo comentário', rr.ids_arquivos.length === 2 && putR['ARQUIVOS[1][ID_ARQUIVO_ARQ]'] === rr.ids_arquivos[1] && SL.chamadas.filter((c) => c.rota === 'arquivos/put').length === 2);
  SL.chamadas = [];
  const rr2 = await D.gravarComentario(ctxR, mreal.itens[3], [{ buffer: pdf('a') }]);
  t('real: mês que já tem o comentário: ja_existia, nenhuma gravação', rr2.estado === 'ja_existia' && escritas().length === 0);
  real('2026-08', 89999, 'Capa', []);
  SL.chamadas = [];
  const rr3 = await D.gravarComentario(ctxR, mreal.itens[0], { buffer: pdf('c') });
  t('real: comentário que existe sem anexo não é criado de novo', rr3.estado === 'incerto' && escritas().length === 0, rr3);
  const s5 = D.montarSituacao({ comp: '2026-09', hoje: '2026-10-01', fechamento: { itens: [{ chave: 'pre_balancete', situacao: 'pendente' }].concat(['conciliacao', 'extrato', 'boletos', 'anexos'].map((x) => ({ chave: x, situacao: 'ok' }))) },
    pre: { pendencias: 2, grupos: [{ chave: 'vencida', itens: [{ gravidade: 'alta', fornecedor: 'ATLAS', valor: 4563, dt_vencimento: '2025-03-28' }, { gravidade: 'alta', fornecedor: 'EDP', valor: 100, dt_vencimento: '2026-09-10' }] }] },
    modelo: { plano: '17', itens: [] }, fechadoAte: '2026-09-30', impressoes: [] });
  t('vencida de mês anterior vira aviso; a do mês trava', s5.avisos.length === 1 && /28\/03\/2025/.test(s5.avisos[0]) && s5.travas.filter((x) => /vencida sem baixa/.test(x.causa)).length === 1 && !s5.travas.some((x) => /Mais \d+ pendência/.test(x.causa)), { avisos: s5.avisos, travas: s5.travas.map((x) => x.causa) });
  SL.comentarios = SL.comentarios.filter((c) => !/_DIAGNOSTICO\//.test(c.st_identificadororigem_como));

  // ── rotas e agendamento (express de verdade, banco em memória) ──
  const express = require('express');
  const app = express();
  const tabelas = {};
  const banco = {
    async ler(c) {
      const [tab, qs] = c.split('?'); const p = new URLSearchParams(qs || '');
      let l = (tabelas[tab] || []).slice();
      for (const [k, v] of p) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        if (v.startsWith('eq.')) l = l.filter((x) => String(x[k]) === v.slice(3));
        if (v.startsWith('in.(')) { const s = v.slice(4, -1).split(','); l = l.filter((x) => s.includes(String(x[k]))); }
      }
      if (p.get('order') === 'id.desc') l.reverse();
      return l.slice(0, Number(p.get('limit')) || 1000);
    },
    async upsert(tab, linhas, conflito) {
      const ks = conflito.split(','); tabelas[tab] = tabelas[tab] || [];
      linhas.forEach((ln) => { const i = tabelas[tab].findIndex((x) => ks.every((k) => String(x[k]) === String(ln[k]))); if (i >= 0) tabelas[tab][i] = Object.assign({}, tabelas[tab][i], ln); else tabelas[tab].push(ln); });
      return linhas.length;
    },
    async inserir(tab, ln) { tabelas[tab] = tabelas[tab] || []; tabelas[tab].push(Object.assign({ id: tabelas[tab].length + 1, em: new Date().toISOString() }, ln)); return true; },
  };
  const guardados = new Map();
  const auditorias = [];
  const politica = W.criarPoliticaEscrita({ auditar: (req, acao, det) => auditorias.push({ acao, det }), condominioDaBase: async (id) => ({ nome: 'Condomínio ' + id }), env: () => ({}) });
  let fechPronto = false;
  const papel = { atual: 'GESTOR' };
  const passa = async () => true;
  const limites = [];
  const R = require('../financeiro/balancete-digital-rotas').criarRotasBalanceteDigital(app, {
    dentroDoLimite: (req, tipo, n) => { limites.push(tipo + ':' + n); return true; },
    requireAuth: (req, res, next) => { req.user = { sub: '00000000-0000-0000-0000-000000000001', email: 'teste@example.com' }; req.authMode = 'jwt'; next(); },
    express, exigirFinanceiro: passa, exigirModuloItem: passa, exigirLeituraSuperlogica: passa, exigirCarteira: passa, carteiraEstrita: passa,
    exigirEscritaSuperlogica: async (req, res) => { if (papel.atual === 'GESTOR') return true; res.status(403).json({ erro: 'acesso_negado' }); return false; },
    exigirEscopoFinanceiro: async () => ({ escopo: null }), escopoFinanceiro: async () => null, gruposCarteiras: async () => [{ id: 5, tipo: 'gerente', gerente: 'Michele', nome: 'Carteira A', condominios: [167] }],
    clienteSL: () => cliente, credSL: () => cred, politica, auditoria: { evento: (req, acao, det) => auditorias.push({ acao, det }) },
    fechamentoT38: { calcular: async () => (fechPronto ? Object.assign({ nome: 'Residencial Teste', falta: [] }, tudoOk) : fechT) },
    painelFin: { preBalancete: async () => preT }, condominios: async () => [{ id: '167', nome: 'Residencial Teste', plano: '17' }],
    supabase: { url: '', chave: '' }, banco, storage: { enviar: async (c, b) => { guardados.set(c, b); }, baixar: async (c) => guardados.get(c) },
    hoje: () => '2026-10-01', log: () => {},
  });
  const srv = http.createServer(app).listen(0);
  const porta = srv.address().port;
  const chamar = (metodo, caminho, corpo) => new Promise((ok) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const r = http.request({ hostname: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: dados ? { 'content-type': 'application/json', 'content-length': dados.length } : {} }, (resp) => {
      const p = []; resp.on('data', (c) => p.push(c)); resp.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) { j = null; } ok({ status: resp.statusCode, j }); });
    });
    r.end(dados || undefined);
  });

  // agendamento do dia 1 no 167: aprende, gera capa e 74A, grava; extrato espera o documento
  SL.comentarios = SL.comentarios.filter((c) => !/\/2026(09|10)$/.test(c.st_identificadororigem_como)); // o mês montado ainda não tem comentários
  SL.fechamento = '01/01/1899';
  SL.chamadas = [];
  const ag = await R.rodarAgenda('2026-10-01');
  t('agenda roda o 167 no dia 1', ag.feito && ag.feito.length === 1 && ag.feito[0].comp === '2026-09', ag);
  const mt = tabelas.fin_balancete_montagem || [];
  t('agenda gravou capa e 74A', mt.filter((x) => x.estado === 'gravado').length === 2, mt.map((x) => x.chave_item + ':' + x.estado));
  t('extrato ficou esperando o documento', mt.some((x) => x.estado === 'falta_documento'));
  t('agenda gerou o 74A pelo Superlógica', SL.chamadas.some((c) => c.rota === 'relatorios/id/074A'));
  t('impressão do 74A apagada depois de virar anexo', SL.chamadas.some((c) => c.rota === 'impressoes/delete'));
  t('agenda não gera 900A com o mês aberto', !SL.chamadas.some((c) => c.rota === 'relatorios/id/900A'));
  t('modelo aprendido salvo sem confirmação', tabelas.fin_balancete_modelo && tabelas.fin_balancete_modelo[0].confirmado === false);
  t('situação gravada para o painel', (tabelas.fin_balancete_situacao || []).length === 1);
  t('gravação do agendamento na auditoria', auditorias.some((a) => a.acao === 'gravacao_superlogica' && a.det.operacao === 'balancete_montar'));

  // documento chega pela tela e a montagem grava
  const chaveExtrato = tabelas.fin_balancete_modelo[0].itens.find((i) => i.fonte.tipo === 'recebido').chave;
  const dr = await chamar('POST', '/api/financeiro/balancete-digital/167/documento', { competencia: '2026-09', chave: chaveExtrato, nome: 'extrato set.pdf', pdf_base64: pdf('extrato set').toString('base64') });
  t('documento recebido', dr.status === 200, dr);
  t('limite de envio de documentos consultado', limites.some((x) => x === 'documento_upload:30'));
  const nao = await chamar('POST', '/api/financeiro/balancete-digital/167/documento', { competencia: '2026-09', chave: chaveExtrato, pdf_base64: Buffer.from('oi').toString('base64') });
  t('documento que não é PDF recusado', nao.status === 400);
  const mr = await chamar('POST', '/api/financeiro/balancete-digital/167/montar', { competencia: '2026-09' });
  t('montar agora no 167 sem confirmação', mr.status === 202 && mr.j.itens === 1, mr);
  await new Promise((ok) => setTimeout(ok, 300));
  t('extrato gravado depois de chegar', (tabelas.fin_balancete_montagem || []).filter((x) => x.estado === 'gravado').length === 3, (tabelas.fin_balancete_montagem || []).map((x) => x.estado));
  const mr2 = await chamar('POST', '/api/financeiro/balancete-digital/167/montar', { competencia: '2026-09' });
  t('nada a gravar de novo', mr2.status === 409);
  const m136 = await chamar('POST', '/api/financeiro/balancete-digital/136/montar', { competencia: '2026-09' });
  t('fora do teste: bloqueado no modo teste', m136.status === 423);

  // fechamento pela pessoa
  const fx = await chamar('POST', '/api/financeiro/balancete-digital/167/fechar-mes', { competencia: '2026-09' });
  t('não fecha com pendência', fx.status === 409 && fx.j.erro === 'nao_pronto', fx);
  fechPronto = true;
  const fy = await chamar('POST', '/api/financeiro/balancete-digital/167/fechar-mes', { competencia: '2026-09' });
  t('fecha com tudo verde e confere', fy.status === 200 && SL.fechamento === '09/30/2026', fy);
  t('registro de quem fechou', (tabelas.fin_balancete_fechamento_log || []).some((x) => x.acao === 'fechar' && x.ok && x.por_email === 'teste@example.com' && x.data_anterior === ''));
  const fz = await chamar('POST', '/api/financeiro/balancete-digital/167/fechar-mes', { competencia: '2026-09' });
  t('não fecha duas vezes', fz.status === 409 && fz.j.erro === 'ja_fechado');
  const ra = await chamar('POST', '/api/financeiro/balancete-digital/167/reabrir-mes', { competencia: '2026-09', motivo: 'curto' });
  t('reabrir exige motivo', ra.status === 400);
  papel.atual = 'ANALISTA';
  const rb = await chamar('POST', '/api/financeiro/balancete-digital/167/reabrir-mes', { competencia: '2026-09', motivo: 'Lançamento da EDP com valor errado' });
  t('só gestor ou gerente reabre', rb.status === 403);
  papel.atual = 'GESTOR';
  const rc = await chamar('POST', '/api/financeiro/balancete-digital/167/reabrir-mes', { competencia: '2026-09', motivo: 'Lançamento da EDP com valor errado' });
  t('reabre para a data de antes (nunca fechado)', rc.status === 200 && SL.fechamento === '01/01/1899', rc);
  t('reabertura registrada com motivo', (tabelas.fin_balancete_fechamento_log || []).some((x) => x.acao === 'reabrir' && /EDP/.test(x.motivo)));
  const pn = await chamar('GET', '/api/financeiro/balancete-digital/painel?competencia=2026-09');
  t('painel mostra causa, quem age, carteira e reaberturas', pn.status === 200 && pn.j.condominios.length === 1 && pn.j.condominios[0].carteira === 'Michele' && pn.j.condominios[0].reaberturas === 1 && Object.keys(pn.j.por_quem).length > 0, pn.j);
  // não duplicar: mês que já tem todos os comentários (montagem esquecida do zero): só ja_existia, sem gerar nem gravar nada
  tabelas.fin_balancete_montagem = [];
  SL.chamadas = [];
  const rnd = await R.montar('167', D.competencia('2026-09'), null, 'teste');
  t('não duplicar: tudo ja_existia', rnd.ja_existiam === 3 && rnd.gravados === 0 && rnd.falhas === 0, rnd);
  t('não duplicar: nenhuma gravação e nenhum relatório gerado', escritas().length === 0 && !SL.chamadas.some((c) => /^relatorios\//.test(c.rota)), SL.chamadas.filter((c) => !c.leitura).map((c) => c.rota));
  // painel: quem precisa agir conta TODAS as travas; a lista vai cortada em 15
  tabelas.fin_balancete_situacao.push({ id_superlogica: 94, competencia: '2026-09', nome: 'Victoria Bay', etapa: 'comprovantes', travas: Array.from({ length: 40 }, (_, i) => ({ etapa: 'comprovantes', causa: 'x' + i, quem: i < 30 ? 'Quem lançou a despesa: anexar' : 'Síndico: autorizar' })), calculado_em: new Date().toISOString() });
  const pq = await chamar('GET', '/api/financeiro/balancete-digital/painel?competencia=2026-09');
  const vb = pq.j.condominios.find((x) => x.id === '94');
  t('painel: lista cortada em 15, total 40', vb.travas.length === 15 && vb.total_travas === 40);
  t('painel: quem precisa agir soma todas as travas', pq.j.por_quem['Quem lançou a despesa'] >= 30 && pq.j.por_quem['Síndico'] >= 10, pq.j.por_quem);
  t('painel: diz quando a agenda roda', pq.j.agenda && pq.j.agenda.horas.length === 3);
  const cc = await chamar('POST', '/api/financeiro/balancete-digital/calcular', { competencia: '2026-09' });
  t('calcular a carteira agora (só leitura)', cc.status === 202 && cc.j.total === 1, cc);
  const cc2 = await chamar('POST', '/api/financeiro/balancete-digital/calcular', { competencia: '2026-09' });
  t('um cálculo de carteira por vez', cc2.status === 409 || cc2.status === 202);
  const nov = await chamar('GET', '/api/financeiro/balancete-digital/167/situacao?competencia=2026-11');
  t('mês que não começou: 400', nov.status === 400);
  await new Promise((ok) => setTimeout(ok, 300));
  srv.close();

  console.log('\n' + (total - falhas) + ' de ' + total + ' testes passaram');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
