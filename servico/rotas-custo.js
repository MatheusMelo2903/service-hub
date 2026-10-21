// T42: painel de custo de processamento. Só o dono (mesma regra da aba Segurança no nível
// dono: ação configuracoes.auditoria_total, dada só pelo banco) ou a chave interna.
// A resposta traz só função, dia e valor: nunca fornecedor nem nome de modelo.

const custo = require('./custo');

const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

function mesDeBrasilia(agora) {
  const br = new Date(agora.getTime() - 3 * 3600000);
  return br.getUTCFullYear() + '-' + String(br.getUTCMonth() + 1).padStart(2, '0');
}

function criarRotasCusto(app, d) {
  const { requireAuth, banco, auditoria } = d;

  async function soDono(req, res) {
    let n = null;
    try { n = await auditoria.nivel(req); } catch (e) { n = null; }
    if (n !== 'dono') {
      try { auditoria.evento(req, 'custo_negado', null, true, 'acesso_negado'); } catch (e) { /* registro nunca derruba */ }
      res.status(403).json({ erro: 'acesso_negado' });
      return false;
    }
    return true;
  }

  // GET /api/custo/resumo?mes=AAAA-MM (padrão: mês corrente em Brasília)
  app.get('/api/custo/resumo', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await soDono(req, res))) return;
    const agora = new Date();
    const mes = RE_MES.test(String(req.query.mes || '')) ? String(req.query.mes) : mesDeBrasilia(agora);
    const [a, m] = mes.split('-').map(Number);
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    // Função do banco (migration 019): filtra pelo índice de criado_em e devolve dia e função.
    let r;
    try { r = await banco('POST', '/rest/v1/rpc/api_uso_resumo', { de: mes + '-01', ate: mes + '-' + String(ultimo).padStart(2, '0') }); } catch (e) { r = null; }
    if (!r || r.status !== 200 || !Array.isArray(r.body)) return res.status(500).json({ erro: 'falha_leitura', detalhe: 'Não foi possível ler o custo agora.' });
    const resumo = custo.resumirMes(r.body, mes, agora, custo.limiteMensal());
    res.json(resumo);
  });
}

module.exports = { criarRotasCusto, mesDeBrasilia };
