'use strict';
// T41 Balancete digital: rotas do Hub. Módulo balancete (ver = conferir, gerar = pedir o 900A) junto
// com o módulo financeiro, acesso ao Superlógica, carteira e escopo. O GESTOR passa pelo módulo sozinho.
//   GET  /api/financeiro/balancete/:id/impressoes?competencia=AAAA-MM   900A do mês (só leitura)
//   GET  /api/financeiro/balancete/:id/conferencia?competencia=AAAA-MM&impressao=<id>
//        dispara (ou devolve) a conferência do PDF: 202 enquanto roda, 200 com o resultado
//   POST /api/financeiro/balancete/:id/gerar { competencia }  pede ao Superlógica o 900A SEM publicar,
//        só para condomínio de BALANCETE_GERACAO_LIBERADA (padrão só o 167)
// Publicar para os condôminos não existe aqui: é sempre clique humano no Superlógica.
const B = require('./balancete');

function criarRotasBalancete(app, h) {
  const { requireAuth, express, exigirFinanceiro, exigirModuloItem, exigirCarteira, exigirEscopo, exigirLeituraSuperlogica, exigirEscritaSuperlogica, idValido, cred, cliente, auditar } = h;

  // Travas comuns. Devolve { id, comp } ou null (já respondeu).
  async function travas(req, res, competenciaBruta) {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica || '');
    if (!idValido(id)) { res.status(400).json({ erro: 'id_invalido', detalhe: 'Código do Superlógica inválido.' }); return null; }
    if (B.EXCLUIDOS.has(id)) { res.status(400).json({ erro: 'nao_condominio', detalhe: 'Esse cadastro não é um condomínio.' }); return null; }
    const c = B.competencia(competenciaBruta);
    if (!c) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Informe o mês no formato AAAA-MM.' }); return null; }
    if (c.chave > B.mesAtualBrasilia()) { res.status(400).json({ erro: 'competencia_invalida', detalhe: 'Escolha um mês que já começou.' }); return null; }
    if (!(await exigirFinanceiro(req, res, 'ver'))) return null;
    if (!(await exigirModuloItem(req, res, 'balancete', 'ver'))) return null;
    if (!(await exigirLeituraSuperlogica(req, res))) return null;
    if (!(await exigirCarteira(req, res, id))) return null;
    if (!(await exigirEscopo(req, res, id))) return null;
    return { id, comp: c.chave };
  }
  const falhaSL = (res, e, rotulo) => {
    console.warn('[balancete] ' + rotulo + ' falhou: ' + (e && e.message));
    res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler o Superlógica agora. Tente de novo em alguns minutos.' });
  };

  app.get('/api/financeiro/balancete/:idSuperlogica/impressoes', requireAuth, async (req, res) => {
    const t = await travas(req, res, req.query.competencia);
    if (!t) return;
    try {
      const lista = await B.listarImpressoes(cliente(), t.id, t.comp);
      lista.forEach((x) => { const s = B.situacaoConferencia(t.id, t.comp, x.id); x.conferencia = s ? s.estado : ''; });
      res.json({ competencia: t.comp, impressoes: lista, geracao_liberada: B.liberadosGeracao().has(t.id) });
    } catch (e) { falhaSL(res, e, 'impressoes ' + t.id); }
  });

  app.get('/api/financeiro/balancete/:idSuperlogica/conferencia', requireAuth, async (req, res) => {
    const imp = String(req.query.impressao || '');
    if (!/^[1-9][0-9]{0,11}$/.test(imp)) { res.set('Cache-Control', 'no-store'); return res.status(400).json({ erro: 'impressao_invalida', detalhe: 'Escolha uma impressão da lista.' }); }
    const t = await travas(req, res, req.query.competencia);
    if (!t) return;
    // Resultado guardado por condomínio, mês e impressão: outro condomínio ou mês nunca recebe este resultado.
    let s = B.situacaoConferencia(t.id, t.comp, imp);
    const repetir = req.query.repetir === '1' && s && s.estado !== 'rodando';
    if (!s || repetir) {
      s = B.iniciarConferencia({ cred: cred(), cliente: cliente(), idCondominio: t.id, competencia: t.comp, idImpressao: imp, log: console.warn, forcar: repetir });
      if (s.estado === 'rodando' && auditar) auditar(req, 'balancete_conferencia', { id_condominio: t.id, competencia: t.comp, impressao: imp }, false);
    }
    if (s.estado === 'ocupado') return res.status(429).json({ erro: 'ocupado', detalhe: 'Outra conferência está rodando. Tente de novo em 2 minutos.' });
    if (s.estado === 'rodando') return res.status(202).json({ estado: 'rodando', desde: new Date(s.inicio).toISOString(), detalhe: 'Baixando e lendo o PDF. Leva de 1 a 3 minutos; a tela pergunta de novo sozinha.' });
    if (s.estado === 'erro') {
      const msg = { nao_encontrada: 'Essa impressão não é um 900A deste condomínio e mês.', outro_mes: 'Essa impressão é de outro mês.', leitura: 'Não foi possível ler o PDF.', memoria: 'O PDF é grande demais para ler aqui.', tempo_esgotado: 'A leitura do PDF passou do tempo.', saida_grande: 'O PDF tem texto demais para ler aqui.', pdf_grande_demais: 'O PDF é maior que o limite.' }[s.erro] || 'Não foi possível conferir agora.';
      return res.status(s.erro === 'nao_encontrada' || s.erro === 'outro_mes' ? 404 : 502).json({ estado: 'erro', erro: s.erro, detalhe: msg + ' Use "Conferir de novo" para repetir.' });
    }
    res.json({ estado: 'pronto', concluido_em: new Date(s.fim).toISOString(), resultado: s.resultado });
  });

  app.post('/api/financeiro/balancete/:idSuperlogica/gerar', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
    const t = await travas(req, res, req.body && req.body.competencia);
    if (!t) return;
    if (!B.liberadosGeracao().has(t.id)) return res.status(403).json({ erro: 'geracao_nao_liberada', detalhe: 'A geração pelo Hub ainda não está liberada para este condomínio.' });
    // Gerar cria uma impressão no Superlógica: exige a ação gerar do módulo, o pré balancete e a trava de escrita.
    if (!(await exigirModuloItem(req, res, 'balancete', 'gerar'))) return;
    if (!(await exigirFinanceiro(req, res, 'pre_balancete'))) return;
    if (!(await exigirEscritaSuperlogica(req, res))) return;
    try {
      const r = await B.pedirGeracao(cred(), t.id, t.comp, { cliente: cliente() });
      if (auditar) auditar(req, 'balancete_gerar', { id_condominio: t.id, competencia: t.comp, http: r.http, impressao: r.id_impressao || '', selecao_ajustada: r.selecao_ajustada ? r.selecao_ajustada.itens_alterados : 0 }, false);
      console.log('[escrita-superlogica] balancete_gerar cond=' + t.id + ' comp=' + t.comp + ' http=' + r.http + ' impressao=' + (r.id_impressao || '-'));
      res.status(202).json({ pedido: true, id_impressao: r.id_impressao, detalhe: (r.selecao_ajustada && r.selecao_ajustada.mudou ? 'Mês da seleção ajustado para ' + t.comp.slice(5) + '/' + t.comp.slice(0, 4) + '. ' : '') + 'Pedido enviado ao Superlógica sem publicar. O 900A aparece na lista em cerca de 3 minutos; depois confira e, se estiver certo, publique pelo Superlógica.' });
    } catch (e) {
      if (e && e.codigo === 'em_andamento') return res.status(409).json({ erro: 'geracao_em_andamento', detalhe: 'Já foi pedido um 900A deste mês há menos de 15 minutos. Aguarde aparecer na lista.' });
      if (e && e.codigo === 'outro_mes_gerando') return res.status(409).json({ erro: 'outro_mes_gerando', detalhe: 'Outro mês está sendo gerado agora. Tente de novo em 6 minutos.' });
      if (e && e.codigo === 'selecao') { console.warn('[balancete] ajuste da seleção falhou: ' + e.message); return res.status(502).json({ erro: 'selecao', detalhe: 'Não foi possível ajustar o mês da seleção no Superlógica. Nada foi gerado.' }); }
      if (e && e.codigo === 'mes_aberto') return res.status(400).json({ erro: 'mes_aberto', detalhe: 'Gere o balancete só depois que o mês terminar.' });
      if (e && e.codigo === 'nao_liberado') return res.status(403).json({ erro: 'geracao_nao_liberada', detalhe: 'A geração pelo Hub ainda não está liberada para este condomínio.' });
      falhaSL(res, e, 'gerar ' + t.id);
    }
  });
}

module.exports = { criarRotasBalancete };
