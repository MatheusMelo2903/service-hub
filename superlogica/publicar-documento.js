'use strict';
// Publicar para os condôminos, pelo Hub, um documento que já está nos documentos do condomínio no
// Superlógica (prestação de contas arquivada e balancete 900A). Decisão do Matheus (24/10/2026):
// "os dois": o Hub publica direto e o botão "Abrir no Superlógica" continua como segunda opção.
//
// Rota (provada no 167 em 23/10/2026 com a chave do Hub, item 6 das rotas de tela):
//   POST impressoes/post com ID_IMPRESSAO_FIMP, FL_PUBLICADOPARA_IMPR (1 condôminos, 0 tira),
//   FL_NOTIFICAR_IMPRESSAO (0 sem aviso, 1 com aviso) e FL_COMPARTILHAR=0, na query e no corpo.
//   Pela chave da API não há reCAPTCHA; a escolha de avisar ou não é da pessoa, na tela.
// Prova: relê impressoes/index e confere fl_publicadopara_impr. Resposta sem confirmação vira
// "sem confirmação": nunca é repetida sozinha; o Hub relê depois e só deixa tentar de novo depois
// de 10 minutos sem confirmação.
// Política única (servico/escrita-superlogica.js): documento_publicar e documento_despublicar,
// operações sensíveis (fora do teste, a pessoa digita o nome do condomínio).
// Testes em scripts/teste-publicar-documento.js.

const BD = require('../financeiro/balancete-digital');

const ID = /^[1-9]\d{0,9}$/;
const ESPERA_RELEITURA = [1500, 4000, 8000];
const PENDENTE_MS = 10 * 60 * 1000;
const RELER_DEPOIS_MS = 2 * 60 * 1000;

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const chaveTitulo = (s) => semAcento(limpar(s)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dataSL = (d) => String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0') + '/' + d.getUTCFullYear();

// "1" condôminos, "2" responsáveis legais, "" ou "0" não publicado.
function situacaoPublicacao(raw) {
  const v = limpar(raw);
  if (v === '1') return 'condominos';
  if (v === '2') return 'responsaveis';
  return 'nao';
}

// Acha o documento do condomínio em impressoes/index (últimos 400 dias, até 300 documentos).
// Pelo id; sem id (ou id que não está lá), pelo título, o mais novo. null = não achou.
async function localizar(cliente, idCond, alvo, agora) {
  const id = String(idCond);
  const fim = new Date((agora || Date.now()) + 24 * 3600 * 1000);
  const ini = new Date(fim.getTime() - 401 * 24 * 3600 * 1000);
  const querId = alvo && alvo.id != null && ID.test(String(alvo.id)) ? String(alvo.id) : '';
  const querTitulo = alvo && alvo.titulo ? chaveTitulo(alvo.titulo) : '';
  const porTitulo = [];
  for (let pg = 1; pg <= 6; pg++) {
    const j = await cliente.get('impressoes/index', { idCondominio: id, dtInicio: dataSL(ini), dtFim: dataSL(fim), itensPorPagina: 50, pagina: pg });
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
    if (!arr) throw Object.assign(new Error('resposta_inesperada'), { codigo: 'leitura' });
    if (arr[0] && arr[0].status != null && String(arr[0].status) !== '200' && !arr[0].id_impressao_fimp) throw Object.assign(new Error('superlogica_' + arr[0].status), { codigo: 'leitura' });
    for (const d of arr) {
      if (!d || String(d.id_empresa_emp) !== id || !d.id_impressao_fimp) continue;
      const item = { id: String(d.id_impressao_fimp), titulo: limpar(d.st_titulo_fimp).slice(0, 160), descricao: limpar(d.st_descricao_fimp).slice(0, 80),
        criado_em: limpar(d.dt_criacao_fimp), publicado_raw: limpar(d.fl_publicadopara_impr), publicacao: situacaoPublicacao(d.fl_publicadopara_impr) };
      if (querId && item.id === querId) return item;
      const t = chaveTitulo(item.titulo);
      if (querTitulo && (t === querTitulo || t === querTitulo + ' pdf')) porTitulo.push(item);
    }
    if (arr.length < 50) break;
  }
  if (querId && !querTitulo) return null;
  return porTitulo.sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

// Grava a publicação (ou a retirada) e relê até confirmar. Devolve { estado: ok | falhou | incerto, item?, msg }.
// ctx: { cred, cliente, idCond, esperar(ms) }; alvo: { id, publicar, avisar }.
async function aplicar(ctx, alvo) {
  const id = String(ctx.idCond);
  if (!ID.test(String(alvo.id))) return { estado: 'falhou', msg: 'Documento inválido.' };
  const campos = { ID_IMPRESSAO_FIMP: String(alvo.id), FL_PUBLICADOPARA_IMPR: alvo.publicar ? '1' : '0', FL_NOTIFICAR_IMPRESSAO: alvo.publicar && alvo.avisar ? '1' : '0', FL_COMPARTILHAR: '0' };
  const corpo = Buffer.from(new URLSearchParams(campos).toString(), 'utf8');
  const r = BD.corpoOk(await BD.pedir(ctx.cred, 'POST', 'impressoes/post', campos, corpo));
  const confere = (it) => (alvo.publicar ? it.publicacao === 'condominos' : it.publicacao === 'nao');
  const esperar = ctx.esperar || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  let lido = null;
  for (const ms of ESPERA_RELEITURA) {
    await esperar(ms);
    try { lido = await localizar(ctx.cliente, id, { id: alvo.id }); } catch (e) { lido = null; }
    if (lido && confere(lido)) return { estado: 'ok', item: lido, msg: alvo.publicar ? 'Publicado e conferido no Superlógica.' : 'Publicação retirada e conferida no Superlógica.' };
    // Recusa clara do Superlógica e a releitura sem mudança: falhou de verdade.
    if (lido && !r.ok && !r.semResposta) return { estado: 'falhou', item: lido, msg: 'O Superlógica recusou: ' + r.msg };
  }
  return { estado: 'incerto', item: lido, msg: r.ok ? 'O Superlógica disse que gravou, mas a releitura ainda não mostra.' : 'Sem resposta do Superlógica.' };
}

// Fluxo único das duas telas (prestação e balancete). deps: { cred(), cliente(), politica, auditoria, esperar?, agendar?, agora? }
function criarPublicador(deps) {
  const pendentes = new Map(); // idCond|idImp -> { ate, publicar }
  const agora = () => (deps.agora ? deps.agora() : Date.now());
  const agendar = deps.agendar || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); });
  const auditar = (req, acao, det, susp) => { try { deps.auditoria.evento(req, acao, det, !!susp, susp ? acao : null); } catch (e) { /* auditoria nunca derruba */ } };

  // Relê depois de uma resposta sem confirmação e registra o que achou (não grava de novo).
  function relerDepois(req, idCond, idImp, publicar) {
    agendar(async () => {
      let it = null;
      try { it = await localizar(deps.cliente(), idCond, { id: idImp }); } catch (e) { it = null; }
      const confirmou = !!it && (publicar ? it.publicacao === 'condominos' : it.publicacao === 'nao');
      if (confirmou) pendentes.delete(idCond + '|' + idImp);
      auditar(req, 'documento_publicacao_relida', { id_superlogica: Number(idCond), id_documento: idImp, publicar, confirmou, situacao: it ? it.publicacao : 'nao_lido' }, !confirmou);
    }, RELER_DEPOIS_MS);
  }

  // p: { idCond, alvo: { id?, titulo? }, acao: 'publicar' | 'despublicar', avisar, documento (rótulo),
  //      competencia (texto), validarItem(item) -> null ou mensagem de recusa }.
  // Responde a requisição (200, 202, 4xx, 5xx ou o 428 da política). Devolve o resultado ou null.
  async function executar(req, res, p) {
    res.set('Cache-Control', 'no-store');
    const idCond = String(p.idCond);
    const publicar = p.acao === 'publicar';
    if (!publicar && p.acao !== 'despublicar') { res.status(400).json({ erro: 'acao_invalida', detalhe: 'Escolha publicar ou retirar a publicação.' }); return null; }
    if (publicar && typeof p.avisar !== 'boolean') { res.status(400).json({ erro: 'escolha_aviso', detalhe: 'Escolha se os moradores serão avisados ou não.' }); return null; }
    const avisar = publicar && p.avisar === true;
    const operacao = publicar ? 'documento_publicar' : 'documento_despublicar';
    if (deps.politica.bloqueada(req, res, operacao, idCond)) return null;
    const cliente = deps.cliente();
    let item;
    try { item = await localizar(cliente, idCond, p.alvo || {}, agora()); } catch (e) {
      res.status(502).json({ erro: 'falha_leitura', detalhe: 'Não foi possível ler os documentos do condomínio no Superlógica agora. Nada foi publicado.' }); return null;
    }
    if (!item) { res.status(404).json({ erro: 'nao_encontrado', detalhe: 'O documento não está nos documentos deste condomínio no Superlógica.' }); return null; }
    const recusa = p.validarItem ? p.validarItem(item) : null;
    if (recusa) { res.status(409).json({ erro: 'documento_nao_confere', detalhe: recusa }); return null; }
    const chave = idCond + '|' + item.id;
    const pend = pendentes.get(chave);
    const jaEsta = publicar ? item.publicacao === 'condominos' : item.publicacao === 'nao';
    if (jaEsta) {
      pendentes.delete(chave);
      res.json({ ok: true, ja_estava: true, id_documento: item.id, publicacao: item.publicacao, detalhe: publicar ? 'O documento já está publicado para os condôminos. Nada foi feito.' : 'O documento já não está publicado. Nada foi feito.' });
      return null;
    }
    if (pend && pend.ate > agora()) {
      res.status(409).json({ erro: 'sem_confirmacao_aguardando', detalhe: 'A última tentativa ficou sem confirmação do Superlógica e o Hub está relendo. Para não repetir, espere alguns minutos e confira de novo.' });
      return null;
    }
    pendentes.delete(chave);
    const competencia = limpar(p.competencia || item.descricao || '').slice(0, 60) || 'não informada';
    const destaque = publicar ? (avisar ? 'COM aviso aos moradores' : 'SEM aviso aos moradores') : 'Retirar a publicação (os condôminos deixam de ver)';
    const aut = await deps.politica.autorizar(req, res, {
      operacao, id_condominio: idCond, conteudo: { id: item.id, publicar, avisar },
      resumo: { destaque, linhas: [{ rotulo: 'Documento', valor: p.documento || 'Documento' }, { rotulo: 'Título', valor: item.titulo }, { rotulo: 'Competência', valor: competencia },
        { rotulo: 'Para quem', valor: publicar ? 'Para os condôminos' : 'Ninguém (volta a ficar só para a administração)' }].concat(publicar ? [{ rotulo: 'Aviso', valor: destaque }] : []) },
    });
    if (!aut) return null;
    const r = await aplicar({ cred: deps.cred(), cliente, idCond, esperar: deps.esperar }, { id: item.id, publicar, avisar });
    aut.concluir({ ok: r.estado === 'ok', id_documento: item.id, publicar, avisar, estado: r.estado });
    auditar(req, publicar ? 'documento_publicado' : 'documento_despublicado', { id_superlogica: Number(idCond), id_documento: item.id, titulo: item.titulo.slice(0, 120), documento: p.documento || null,
      avisar, estado: r.estado, por: (req.user && req.user.email) || req.authMode || null }, r.estado !== 'ok');
    if (r.estado === 'incerto') {
      pendentes.set(chave, { ate: agora() + PENDENTE_MS, publicar });
      relerDepois(req, idCond, item.id, publicar);
      res.status(202).json({ ok: false, sem_confirmacao: true, id_documento: item.id, detalhe: 'Sem confirmação do Superlógica. O Hub não repete sozinho: relê daqui a pouco. Confira em alguns minutos antes de tentar de novo.' });
      return r;
    }
    if (r.estado === 'falhou') { res.status(502).json({ erro: 'falhou', id_documento: item.id, detalhe: r.msg + ' Nada mudou no Superlógica.' }); return r; }
    res.json({ ok: true, id_documento: item.id, publicacao: r.item.publicacao, avisou: avisar, detalhe: r.msg + (publicar ? (avisar ? ' Os moradores foram avisados.' : ' Os moradores não foram avisados.') : '') });
    return r;
  }

  return { executar, _pendentes: pendentes };
}

module.exports = { criarPublicador, localizar, aplicar, situacaoPublicacao, ESPERA_RELEITURA, PENDENTE_MS };
