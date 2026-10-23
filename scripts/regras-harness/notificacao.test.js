// Testes da frente C (notificação, multa e comunicado citando o regimento), sem rede:
// node scripts/regras-harness/notificacao.test.js
// Banco, Superlógica e modelo são falsos; os trechos imitam a convenção do Victoria Bay (art. 44).

const N = require('../../servico/regras/notificacao');

let ok = 0, falhou = 0;
function t(nome, cond, extra) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : '')); } }

const ID = 167;
const TRECHOS = [
  { trecho_id: 11, documento_id: 1, id_superlogica: ID, tipo: 'convencao', titulo_documento: 'Convenção de Condomínio', data_documento: '2015-03-01', rotulo: 'Art. 44', titulo: 'Capítulo X', texto: 'Art. 44. A infração a qualquer dispositivo desta Convenção ou do Regimento Interno será punida com advertência escrita do síndico que, não atendida em 3 (três) dias, converter-se-á em multa de 50% (cinquenta por cento) das despesas ordinárias da unidade no mês anterior.', rank: 0.9 },
  { trecho_id: 12, documento_id: 2, id_superlogica: ID, tipo: 'regimento', titulo_documento: 'Regimento Interno', data_documento: '2018-05-10', rotulo: 'Art. 12', titulo: null, texto: 'Art. 12. É proibido produzir ruídos que perturbem o sossego dos moradores entre 22h e 8h.', rank: 0.8 },
  { trecho_id: 13, documento_id: 1, id_superlogica: ID, tipo: 'convencao', titulo_documento: 'Convenção de Condomínio', data_documento: '2015-03-01', rotulo: 'Art. 45', titulo: 'Capítulo X', texto: 'Art. 45. Em caso de reincidência, a multa será aplicada em dobro.', rank: 0.7 },
  { trecho_id: 14, documento_id: 1, id_superlogica: ID, tipo: 'convencao', titulo_documento: 'Convenção de Condomínio', data_documento: '2015-03-01', rotulo: 'Art. 46', titulo: 'Capítulo X', texto: 'Art. 46. A multa por infração grave será de 2 (dois) salários mínimos vigentes.', rank: 0.6 },
];

// Banco falso: regras_buscar devolve os trechos do cenário; regras_notificacoes em memória.
function bancoFalso(cen) {
  const notifs = (cen.notificacoes || []).map((n) => Object.assign({}, n));
  let seq = 1000;
  const chamadas = [];
  const fn = async (metodo, caminho, corpo) => {
    chamadas.push([metodo, caminho]);
    const url = new URL('http://x' + caminho);
    const p = url.searchParams;
    if (caminho.startsWith('/rest/v1/rpc/regras_buscar')) return { status: 200, body: (cen.trechos || []).slice() };
    if (caminho.startsWith('/rest/v1/regras_trechos')) {
      const ids = (p.get('id') || '').replace(/^in\.\(|\)$/g, '').split(',').map(Number);
      return { status: 200, body: (cen.trechos || []).filter((t) => ids.includes(t.trecho_id)).map((t) => ({ id: t.trecho_id, documento_id: t.documento_id, rotulo: t.rotulo, texto: t.texto, pagina: null, regras_documentos: { tipo: t.tipo, titulo: t.titulo_documento, data_documento: t.data_documento } })) };
    }
    if (caminho.startsWith('/rest/v1/regras_notificacoes')) {
      const cond = Number((p.get('id_superlogica') || '').replace('eq.', ''));
      if (metodo === 'GET') {
        let lista = notifs.filter((n) => !cond || n.id_superlogica === cond);
        if (p.get('id')) lista = lista.filter((n) => n.id === Number(p.get('id').replace('eq.', '')));
        const or = p.get('or');
        if (or) {
          const conds = or.replace(/^\(|\)$/g, '').split(',');
          lista = lista.filter((n) => conds.some((c) => {
            const m = c.match(/^(id_unidade)\.eq\.(\d+)$/); if (m) return n.id_unidade === Number(m[2]);
            const k = c.match(/^unidade\.ilike\.(.*)$/); if (k) return String(n.unidade || '').toLowerCase() === decodeURIComponent(k[1]).toLowerCase();
            return false;
          }));
        }
        return { status: 200, body: lista };
      }
      if (metodo === 'POST') { const n = Object.assign({ id: ++seq, criado_em: new Date().toISOString() }, corpo); notifs.push(n); return { status: 201, body: [n] }; }
      if (metodo === 'PATCH') {
        const id = Number((p.get('id') || '').replace('eq.', ''));
        const st = (p.get('status') || '').replace('eq.', '');
        const n = notifs.find((x) => x.id === id && (!st || x.status === st));
        if (!n) return { status: 200, body: [] };
        Object.assign(n, corpo); return { status: 200, body: [n] };
      }
    }
    return { status: 404, body: null };
  };
  fn.notifs = notifs; fn.chamadas = chamadas;
  return fn;
}

// Superlógica falso: unidades com contatos e cobranças do mês anterior.
function slFalso(cen) {
  return {
    get: async (rota) => {
      if (rota === 'unidades/index') return cen.unidades || [];
      if (rota === 'cobranca/index') return cen.cobrancas || [];
      throw new Error('rota inesperada ' + rota);
    },
  };
}

const UNIDADES = [
  { id_unidade_uni: '501', st_unidade_uni: '101', st_bloco_uni: 'A', nome_proprietario: 'Maria Souza', email_proprietario: 'maria@exemplo.com',
    contatos: [{ st_nome_con: 'Maria Souza', id_tiporesp_tres: '1', st_nometiporesp_tres: 'Proprietário' }, { st_nome_con: 'João Lima', id_tiporesp_tres: '7', st_nometiporesp_tres: 'Inquilino', st_email_con: 'joao@exemplo.com' }] },
  { id_unidade_uni: '502', st_unidade_uni: '102', st_bloco_uni: 'A', nome_proprietario: 'Pedro Alves', contatos: [] },
];
// Boleto da unidade 501: taxa ordinária 800, fundo de reserva 80, consumo de água 45.
const COBRANCAS = [
  { id_recebimento_recb: '9001', id_unidade_uni: '501', st_unidade_uni: '101', st_bloco_uni: 'A', dt_vencimento_recb: '09/10/2026', vl_emitido_recb: '925.00', fl_status_recb: '3',
    receita_apropriacao: [{ st_conta_cont: '1.1', st_descricao_cont: 'Taxa de condomínio ordinária', vl_valor_rec: '800.00' }, { st_conta_cont: '1.2', st_descricao_cont: 'Fundo de reserva', vl_valor_rec: '80.00' }, { st_conta_cont: '1.3', st_descricao_cont: 'Consumo de água', vl_valor_rec: '45.00' }] },
  { id_recebimento_recb: '9002', id_unidade_uni: '502', st_unidade_uni: '102', st_bloco_uni: 'A', dt_vencimento_recb: '09/10/2026', vl_emitido_recb: '850.00', fl_status_recb: '3',
    receita_apropriacao: [{ st_conta_cont: '1.1', st_descricao_cont: 'Taxa de condomínio ordinária', vl_valor_rec: '800.00' }, { st_conta_cont: '1.9', st_descricao_cont: 'Seguro predial', vl_valor_rec: '50.00' }] },
];

// Monta deps com o modelo devolvendo a resposta pedida no cenário.
function deps(cen) {
  N._limparCache();
  const banco = bancoFalso(cen);
  const pedidos = [];
  return {
    banco,
    pedidos,
    clienteSL: () => slFalso(cen),
    buscarCadastro: async (cli, id) => ({ id_superlogica: id, nome: 'Condomínio Victoria Bay', nome_fantasia: 'Victoria Bay', cnpj: '00.000.000/0001-00', endereco: { completo: 'Rua A, 1, Vitória/ES' } }),
    modelos: { modelo: () => 'modelo-teste' },
    chamarModelo: async (o) => { pedidos.push(o); return { ok: true, texto: JSON.stringify(cen.resposta) }; },
  };
}

const CARTA = 'Prezado(a) Senhor(a),\n\nNo dia 10/10/2026 foi registrado barulho na unidade 101 A após as 22h, contrariando as regras de sossego do condomínio.\n\nSolicitamos a regularização.\n\nAtenciosamente,\n\nA Administração do Victoria Bay';

function resposta(extra) {
  return Object.assign({
    tipo_sugerido: 'multa', motivo_sugestao: 'Já houve advertência pelo mesmo assunto.', titulo: 'Notificação de multa por barulho', texto: CARTA,
    fundamentos: [{ trecho_id: 12, citacao: 'É proibido produzir ruídos que perturbem o sossego dos moradores entre 22h e 8h' }],
    regra_valor: { trecho_id: 11, citacao: 'advertência escrita do síndico que, não atendida em 3 (três) dias, converter-se-á em multa de 50% (cinquenta por cento) das despesas ordinárias da unidade no mês anterior', forma: 'percentual_taxa', numero: 50, reincidencia_multiplica: false },
    prazo_regularizacao_dias: 3,
  }, extra || {});
}

async function main() {
  const HOJE = new Date(Date.UTC(2026, 9, 22));

  // 1. Regra de 50% da taxa ordinária do mês anterior (800 -> 400; fundo e consumo fora).
  {
    const d = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resposta() });
    const r = await N.rascunho(d, ID, { idUnidade: 501, relato: 'Barulho após as 22h na unidade 101 A, relatado pela portaria.', data_fato: '10/10/2026', hoje: HOJE });
    t('taxa ordinária 800', r.taxa.valor === 800, r.taxa);
    t('competência do mês anterior', r.taxa.competencia === '09/2026', r.taxa.competencia);
    t('50% da taxa = 400', r.valor.valor === 400, r.valor);
    t('conta mostrada na carta', /R\$ 400,00/.test(r.texto) && /50% de R\$ 800,00/.test(r.texto), r.texto);
    t('fundamentação com trecho literal entre aspas', /Fundamentação:/.test(r.texto) && /Art\. 12 do Regimento Interno \(Regimento Interno\): "É proibido produzir ruídos/.test(r.texto), r.texto);
    t('regra de valor entra na fundamentação', r.fundamentos.some((f) => f.trecho_id === 11), r.fundamentos);
    t('prazo de 3 dias conferido', r.prazo.dias === 3 && /Prazo para regularização: 3 dias/.test(r.texto), r.prazo);
    const dAdv = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resposta({ prazo_regularizacao_dias: 10 }) });
    const rAdv = await N.rascunho(dAdv, ID, { idUnidade: 501, relato: 'Barulho após as 22h.', data_fato: '10/10/2026', tipo_pedido: 'advertencia', hoje: HOJE });
    t('advertência pedida: sem linha de valor', rAdv.tipo === 'advertencia' && !/Valor da multa/.test(rAdv.texto), rAdv.texto);
    t('prazo que não está no trecho vira [a confirmar]', rAdv.prazo.dias === null && /Prazo para regularização: \[a confirmar\]/.test(rAdv.texto), rAdv.prazo);
    // Veredito da tela de análise: resposta sem enquadramento e com trecho conferido cabe penalidade.
    t('veredito: cabe penalidade com trecho conferido', r.veredito && r.veredito.situacao === 'cabe_penalidade', r.veredito);
    t('veredito: sem trecho conferido não há regra, mesmo com enquadramento coberto', N.vereditoDoCaso({ aprovados: [], enquadramento: 'coberto', tipo: 'advertencia', valor: null }).situacao === 'sem_regra');
    t('veredito: modelo diz que não cobre', N.vereditoDoCaso({ aprovados: [{}], enquadramento: 'nao_coberto', tipo: 'advertencia', valor: null }).situacao === 'sem_regra');
    t('veredito: dúvida fica a confirmar', N.vereditoDoCaso({ aprovados: [{}], enquadramento: 'duvida', tipo: 'advertencia', valor: null }).situacao === 'a_confirmar');
    t('veredito: multa sem valor fica a confirmar', N.vereditoDoCaso({ aprovados: [{}], enquadramento: 'coberto', tipo: 'multa', valor: { valor: null } }).situacao === 'a_confirmar');
    t('inquilino lido do Superlógica', r.unidade.inquilino === 'João Lima' && r.unidade.email_inquilino === 'joao@exemplo.com', r.unidade);
    t('sem hífen nem travessão na carta', !/[-–—]/.test(r.texto), r.texto.match(/.{0,20}[-–—].{0,20}/));
    t('sem < > na carta', !/[<>]/.test(r.texto));
    t('fecho no fim', /Atenciosamente,\n\nA Administração do Victoria Bay$/.test(r.texto), r.texto.slice(-80));
    const principais = d.pedidos.filter((p) => /<trecho id=/.test(String(p.content)));
    t('um pedido principal ao modelo com trechos (mais a busca de sinônimos)', principais.length === 1 && /<trecho id="11"/.test(principais[0].content) && principais[0].funcao === 'regras');
  }

  // 2. Citação inventada some da carta (e o artigo que o modelo escreveu sem fundamento vira [a confirmar]).
  {
    const d = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resposta({
      texto: CARTA.replace('Solicitamos a regularização.', 'Conforme o Art. 99, "é vedado ao condômino tocar música alta em qualquer horário". Solicitamos a regularização.'),
      fundamentos: [{ trecho_id: 12, citacao: 'É proibido tocar música alta em qualquer horário' }, { trecho_id: 777, citacao: 'Texto de trecho que não foi dado' }],
    }) });
    const r = await N.rascunho(d, ID, { idUnidade: 501, relato: 'Música alta na unidade.', data_fato: '10/10/2026', hoje: HOJE });
    t('citação inventada não aparece', !/tocar música alta em qualquer horário/.test(r.texto), r.texto);
    t('trecho fora da lista não aparece', !/Texto de trecho que não foi dado/.test(r.texto));
    t('artigo sem fundamento vira [a confirmar]', !/Art\. 99/.test(r.texto) && /\[a confirmar\]/.test(r.texto), r.texto);
    t('recusados contados', r.recusados === 2, r.recusados);
    t('fundamentos só os aprovados', r.fundamentos.every((f) => f.trecho_id === 11), r.fundamentos);
  }

  // 3. Regra de valor com citação inventada não calcula.
  {
    const d = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resposta({
      regra_valor: { trecho_id: 11, citacao: 'multa de 200% das despesas ordinárias', forma: 'percentual_taxa', numero: 200, reincidencia_multiplica: false },
    }) });
    const r = await N.rascunho(d, ID, { idUnidade: 501, relato: 'Barulho após as 22h.', data_fato: '10/10/2026', hoje: HOJE });
    t('valor null com citação inventada', r.valor.valor === null, r.valor);
    t('carta diz valor a confirmar', /Valor da multa: \[a confirmar\]/.test(r.texto), r.texto);
    t('não cita 200%', !/200%/.test(r.texto));
    // Citação verdadeira mas número que não está nela também não calcula.
    const d2 = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resposta({
      regra_valor: { trecho_id: 11, citacao: 'converter-se-á em multa de 50% (cinquenta por cento) das despesas ordinárias', forma: 'percentual_taxa', numero: 80, reincidencia_multiplica: false },
    }) });
    const r2 = await N.rascunho(d2, ID, { idUnidade: 501, relato: 'Barulho após as 22h.', data_fato: '10/10/2026', hoje: HOJE });
    t('número fora da citação não calcula', r2.valor.valor === null, r2.valor);
  }

  // 4. Salário mínimo sem a variável vira [a confirmar]; com a variável calcula.
  {
    const antes = process.env.SALARIO_MINIMO;
    delete process.env.SALARIO_MINIMO;
    const resp = resposta({ regra_valor: { trecho_id: 14, citacao: 'A multa por infração grave será de 2 (dois) salários mínimos vigentes', forma: 'salario_minimo', numero: 2, reincidencia_multiplica: false } });
    const d = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resp });
    const r = await N.rascunho(d, ID, { idUnidade: 501, relato: 'Infração grave.', data_fato: '10/10/2026', hoje: HOJE });
    t('salário mínimo sem variável: valor null', r.valor.valor === null && /\[a confirmar\]/.test(r.valor.motivo), r.valor);
    t('salário mínimo sem variável: carta a confirmar', /Valor da multa: \[a confirmar\]/.test(r.texto));
    process.env.SALARIO_MINIMO = '1518';
    const d2 = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resp });
    const r2 = await N.rascunho(d2, ID, { idUnidade: 501, relato: 'Infração grave.', data_fato: '10/10/2026', hoje: HOJE });
    t('salário mínimo com variável: 2 x 1518', r2.valor.valor === 3036, r2.valor);
    if (antes === undefined) delete process.env.SALARIO_MINIMO; else process.env.SALARIO_MINIMO = antes;
  }

  // 5. Reincidência só multiplica com citação aprovada que fale dela (e com multa anterior).
  {
    const multaAnterior = [{ id: 1, id_superlogica: ID, id_unidade: 501, unidade: '101', bloco: 'A', tipo: 'multa', status: 'registrada', origem: 'hub', data_fato: '2026-08-01', ocorrencia: 'Barulho após as 22h', criado_em: '2026-08-02T10:00:00Z' }];
    const semCitacao = resposta({ regra_valor: Object.assign({}, resposta().regra_valor, { reincidencia_multiplica: true }) });
    const d = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, notificacoes: multaAnterior, resposta: semCitacao });
    const r = await N.rascunho(d, ID, { idUnidade: 501, relato: 'Barulho de novo após as 22h.', data_fato: '10/10/2026', hoje: HOJE });
    t('sem citação de reincidência não multiplica', r.valor.valor === 400 && r.valor.reincidencia && r.valor.reincidencia.aplicada === false, r.valor);
    const comCitacao = resposta({
      fundamentos: resposta().fundamentos.concat([{ trecho_id: 13, citacao: 'Em caso de reincidência, a multa será aplicada em dobro' }]),
      regra_valor: Object.assign({}, resposta().regra_valor, { reincidencia_multiplica: true }),
    });
    const d2 = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, notificacoes: multaAnterior, resposta: comCitacao });
    const r2 = await N.rascunho(d2, ID, { idUnidade: 501, relato: 'Barulho de novo após as 22h.', data_fato: '10/10/2026', hoje: HOJE });
    t('com citação e multa anterior: dobra', r2.valor.valor === 800 && r2.valor.reincidencia.aplicada === true, r2.valor);
    t('conta da reincidência na carta', /vezes 2 pela reincidência = R\$ 800,00/.test(r2.texto), r2.texto);
    t('aviso de reincidência', /já tem 1 notificação/.test(r2.aviso_reincidencia || ''), r2.aviso_reincidencia);
    const d3 = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: comCitacao });
    const r3 = await N.rascunho(d3, ID, { idUnidade: 501, relato: 'Barulho após as 22h.', data_fato: '10/10/2026', hoje: HOJE });
    t('com citação mas sem multa anterior: não dobra', r3.valor.valor === 400, r3.valor);
  }

  // 6. Histórico pelo texto da unidade encontra o importado do CondGPT (sem id da unidade).
  {
    const importado = [
      { id: 7, id_superlogica: ID, id_unidade: null, unidade: '101 A', tipo: 'advertencia', status: 'registrada', origem: 'condgpt', data_fato: '2025-11-03', ocorrencia: 'Advertência por barulho', criado_em: '2025-11-03T12:00:00Z' },
      { id: 8, id_superlogica: ID, id_unidade: 502, unidade: '101 A', tipo: 'multa', status: 'registrada', origem: 'hub', data_fato: '2025-12-01', ocorrencia: 'De outra unidade', criado_em: '2025-12-01T12:00:00Z' },
      { id: 9, id_superlogica: 999, id_unidade: null, unidade: '101 A', tipo: 'multa', status: 'registrada', origem: 'condgpt', data_fato: '2025-12-01', ocorrencia: 'De outro condomínio', criado_em: '2025-12-01T12:00:00Z' },
    ];
    const d = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, notificacoes: importado, resposta: resposta() });
    const r = await N.rascunho(d, ID, { idUnidade: 501, relato: 'Barulho após as 22h.', data_fato: '10/10/2026', hoje: HOJE });
    t('importado do CondGPT encontrado pelo texto', r.historico.some((h) => h.id === 7 && h.origem === 'condgpt'), r.historico);
    t('linha de outra unidade fica fora', !r.historico.some((h) => h.id === 8));
    t('linha de outro condomínio fica fora', !r.historico.some((h) => h.id === 9));
    t('histórico vai ao modelo', d.pedidos.some((p) => /Advertência por barulho/.test(String(p.content))));
    t('grafias da unidade', JSON.stringify(N.grafiasUnidade({ unidade: '101', bloco: 'A' })) === JSON.stringify(['101 A', 'A 101', 'A101', '101A']));
  }

  // 7. Comunicado sem fundamento não ganha parágrafo de regra; com fundamento ganha a citação literal.
  {
    const semFund = { titulo: 'Limpeza da caixa d\'água', texto: 'Prezados condôminos,\n\nInformamos a limpeza da caixa d\'água no dia [a confirmar].\n\nAtenciosamente,\n\nA Administração do Victoria Bay', fundamentos: [{ trecho_id: 12, citacao: 'É proibido lavar a garagem' }] };
    const d = deps({ trechos: TRECHOS, resposta: semFund });
    const r = await N.comunicadoComRegras(d, ID, { tipo: 'comunicado', assunto: 'limpeza da caixa d\'água', detalhes: '' });
    t('comunicado sem fundamento: sem "Conforme"', !/Conforme/.test(r.texto), r.texto);
    t('comunicado sem fundamento: fundamentos vazios', Array.isArray(r.fundamentos) && r.fundamentos.length === 0);
    t('comunicado mantém formato titulo e texto', typeof r.titulo === 'string' && typeof r.texto === 'string');
    const comFund = Object.assign({}, semFund, { titulo: 'Silêncio após as 22h', texto: 'Prezados condôminos,\n\nLembramos o horário de silêncio.\n\nAtenciosamente,\n\nA Administração do Victoria Bay', fundamentos: [{ trecho_id: 12, citacao: 'É proibido produzir ruídos que perturbem o sossego dos moradores entre 22h e 8h' }] });
    const d2 = deps({ trechos: TRECHOS, resposta: comFund });
    const r2 = await N.comunicadoComRegras(d2, ID, { tipo: 'comunicado', assunto: 'barulho', detalhes: '' });
    t('comunicado com fundamento: parágrafo da regra', /Conforme o Art\. 12 do Regimento Interno: "É proibido produzir ruídos/.test(r2.texto), r2.texto);
    t('parágrafo antes do fecho', r2.texto.indexOf('Conforme') < r2.texto.indexOf('Atenciosamente'));
  }

  // 8. Taxa não separável com segurança devolve null e o motivo.
  {
    const d = deps({ unidades: UNIDADES, cobrancas: COBRANCAS });
    const tx = await N.taxaMesAnterior(d, ID, 502, HOJE);
    t('item duvidoso: taxa null com motivo', tx.valor === null && /não dá para separar/.test(tx.motivo), tx);
    const d2 = deps({ unidades: UNIDADES, cobrancas: [] });
    const tx2 = await N.taxaMesAnterior(d2, ID, 501, HOJE);
    t('sem boleto: taxa null com motivo', tx2.valor === null && /não tem boleto/.test(tx2.motivo), tx2);
    t('extraordinária não é ordinária', !N.ehOrdinaria('Taxa extraordinária') && N.ehOrdinaria('Taxa ordinária'));
  }

  // 9. Salvar (unidade do condomínio, fundamentos reconferidos) e mudar status.
  {
    const d = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS });
    let erroUni = null;
    try { await N.salvar(d, ID, { tipo: 'multa', texto: 'Carta', id_unidade: 999 }); } catch (e) { erroUni = e; }
    t('unidade de fora recusada', erroUni && erroUni.status === 400);
    const n = await N.salvar(d, ID, { tipo: 'multa', texto: 'Carta — com travessão', id_unidade: 501, valor: 400, data_fato: '10/10/2026',
      fundamentos: [{ trecho_id: 12, citacao: 'É proibido produzir ruídos que perturbem o sossego' }, { trecho_id: 12, citacao: 'texto inventado pela tela' }] }, 'u1');
    t('salvo como rascunho', n.status === 'rascunho' && n.origem === 'hub' && n.unidade === '101' && n.bloco === 'A');
    t('fundamento inventado não é salvo', n.fundamentos.length === 1 && n.fundamentos[0].trecho_id === 12, n.fundamentos);
    t('texto salvo sem travessão', !/[–—]/.test(n.texto), n.texto);
    t('destinatário é o inquilino', n.destinatario === 'João Lima');
    const reg = await N.mudarStatus(d, n, { status: 'registrada', id_ocorrencia_sl: '555', id_cobranca_sl: '777' });
    t('registrada com ids', reg.status === 'registrada' && reg.id_ocorrencia_sl === '555' && reg.id_cobranca_sl === '777');
    let erroTr = null;
    try { await N.mudarStatus(d, Object.assign({}, reg, { status: 'cancelada' }), { status: 'registrada' }); } catch (e) { erroTr = e; }
    t('transição inválida recusada', erroTr && erroTr.status === 409);
    const lista = await N.listar(d, ID, { tipo: 'multa' });
    t('listar por condomínio', lista.length === 1);
  }

  // 10. Rotas: permissão do módulo, carteira e PATCH só de notificação da carteira.
  {
    const { criarRotasNotificacao } = require('../../servico/regras/rotas-notificacao');
    const rotas = {};
    const app = {};
    ['get', 'post', 'patch'].forEach((m) => { app[m] = (caminho, ...fns) => { rotas[m.toUpperCase() + ' ' + caminho] = fns; }; });
    const base = deps({ trechos: TRECHOS, unidades: UNIDADES, cobrancas: COBRANCAS, resposta: resposta(),
      notificacoes: [{ id: 50, id_superlogica: 999, id_unidade: 1, unidade: '1', tipo: 'multa', status: 'registrada', origem: 'hub', criado_em: '2026-01-01' }] });
    const eventos = [];
    const carteira = new Set(['167']);
    Object.assign(base, {
      requireAuth: (req, res, next) => next(), express: { json: () => (req, res, next) => next() },
      perfilDe: async (req) => req.perfil, podeModulo: (p, m, a) => !!(p && p.pode && m === 'regras' && a === 'notificar'),
      exigirCarteira: async (req, res, id) => { if (carteira.has(String(id))) return true; res.status(403).json({ erro: 'fora_da_carteira' }); return false; },
      exigirLeituraSuperlogica: async () => true, dentroDoLimite: () => true, auditoria: { evento: (req, acao, det) => eventos.push([acao, det]) },
    });
    criarRotasNotificacao(app, base);
    async function chamar(chave, req) {
      const fns = rotas[chave];
      const res = { st: 200, j: null, headersSent: false, set() { return res; }, status(s) { res.st = s; return res; }, json(j) { res.j = j; res.headersSent = true; return res; } };
      req = Object.assign({ params: {}, query: {}, body: {}, user: { sub: 'u1' }, authMode: 'supabase' }, req);
      let i = 0;
      const next = async () => { const f = fns[i++]; if (f) await f(req, res, next); };
      await next();
      return res;
    }
    const sem = await chamar('GET /api/regras/:idSuperlogica/unidades', { params: { idSuperlogica: '167' }, perfil: { pode: false } });
    t('rota sem permissão: 403', sem.st === 403, sem);
    const fora = await chamar('GET /api/regras/:idSuperlogica/unidades', { params: { idSuperlogica: '999' }, perfil: { pode: true } });
    t('rota fora da carteira: 403', fora.st === 403 && fora.j.erro === 'fora_da_carteira', fora);
    const okLista = await chamar('GET /api/regras/:idSuperlogica/unidades', { params: { idSuperlogica: '167' }, perfil: { pode: true } });
    t('lista de unidades sem e-mail', okLista.st === 200 && okLista.j.unidades.length === 2 && !('email_proprietario' in okLista.j.unidades[0]) && okLista.j.unidades[0].inquilino === 'João Lima', okLista.j);
    const patchFora = await chamar('PATCH /api/regras/notificacao/:id', { params: { id: '50' }, body: { status: 'regularizada' }, perfil: { pode: true } });
    t('PATCH de notificação de fora da carteira: 403', patchFora.st === 403, patchFora);
    const salvo = await chamar('POST /api/regras/:idSuperlogica/notificacao', { params: { idSuperlogica: '167' }, body: { tipo: 'advertencia', texto: 'Carta', id_unidade: 501 }, perfil: { pode: true } });
    t('salvar grava auditoria', salvo.st === 200 && eventos.some((e) => e[0] === 'regras_notificacao_salva'), salvo);
    const rasc = await chamar('POST /api/regras/:idSuperlogica/notificacao/rascunho', { params: { idSuperlogica: '167' }, body: { id_unidade: 501, relato: 'Barulho após as 22h.' }, perfil: { pode: true } });
    t('rascunho pela rota', rasc.st === 200 && rasc.j.valor && typeof rasc.j.texto === 'string', rasc.j);
  }

  console.log(ok + ' ok, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
