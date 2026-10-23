// ─────────────────────────────────────────────────────────────────────────
// T51: Central de alertas. A carteira toda numa tela só, separada por área, e as preferências
// de cada pessoa ("Meus alertas": desligar tipos ou pausar todos).
//
// GET /api/central-alertas?carteira=<meus|id ou nome da carteira>&forcar=0|1[&resolvidos=1]
//   Junta três origens, sempre dentro da carteira de quem chama (mesma regra da T18):
//   . condominio: linhas da tabela alertas (gravadas pelo Dashboard) dos condomínios da carteira.
//     Para não mostrar alerta velho (conta que já foi paga continua "novo" na tabela), quando o
//     condomínio já foi calculado vale só o que o último cálculo achou, como no Dashboard.
//     Os condomínios sem cálculo nas últimas 6 horas entram numa fila em segundo plano, um por
//     vez e com teto de tempo, usando a MESMA função que o Dashboard usa para calcular e gravar.
//     A resposta nunca espera a fila: devolve o que já tem e "atualizando": true.
//   . financeiro: a base da carteira do painel Financeiro (financeiro/painel.js, já em cache), só
//     para quem tem o módulo Financeiro. Espera no máximo alguns segundos; depois vem na próxima.
//   . seguranca: os "Alertas de uso" da aba Segurança, só para quem tem ver_auditoria ou
//     auditoria_total (mesmo cálculo da aba, servico/rotas-seguranca.js).
// GET /api/alertas/preferencias e PUT /api/alertas/preferencias { silenciados, pausado }
//   Preferência POR PESSOA (tabela alertas_preferencias, migration 023). Silenciar não apaga nem
//   para de gerar: só marca silenciado:true nas respostas, e a tela esconde. Gravar exige a ação
//   central_alertas.silenciar (GESTOR sempre). Quem não pode silenciar vê tudo sempre, mesmo que
//   tenha preferência antiga guardada.
// As funções aplicarPreferencias e preferenciasDoPedido também são usadas pelas rotas que já
// existiam (Dashboard, Seu dia e painel Financeiro), para a marcação ser a mesma em todo lugar.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_SL = /^[1-9][0-9]{0,8}$/;
// Cadastros que não são condomínios (empresas do grupo): fora da Central, como no Seu dia.
const EXCLUIDOS = new Set(['143', '144', '145', '160', '162']);
const MODULO = 'central_alertas';

const SEIS_HORAS = 6 * 3600 * 1000;
const TENTAR_DE_NOVO_MS = 30 * 60 * 1000;  // cálculo parcial ou que estourou o teto
const FORCAR_MIN_MS = 15 * 60 * 1000;      // "Atualizar" não recalcula o que tem menos de 15 min
const TETO_PADRAO_MS = 90 * 1000;          // teto de um condomínio na fila
const ESPERA_FIN_PADRAO_MS = 3000;         // quanto a resposta espera a base do Financeiro
const CACHE_PREF_MS = 30 * 1000;
const CACHE_COND_MS = 10 * 60 * 1000;
const MAX_ALERTAS = 6000;
const DIAS_RESOLVIDOS = 90;

const AREAS = [
  { area: 'financeiro', nome: 'Financeiro' },
  { area: 'operacional', nome: 'Operacional' },
  { area: 'documentos', nome: 'Documentos e jurídico' },
  { area: 'seguranca', nome: 'Segurança' },
];

// Catálogo dos tipos que a pessoa liga e desliga. A chave é o "tipo" que a Central devolve.
// origem diz quem enxerga o tipo na lista de "Meus alertas" (financeiro e segurança dependem
// de permissão).
const TIPOS = [
  { tipo: 'conta_a_vencer', rotulo: 'Conta a pagar vencendo', area: 'financeiro', origem: 'condominio' },
  { tipo: 'saldo_baixo', rotulo: 'Saldo baixo na conta principal', area: 'financeiro', origem: 'condominio' },
  { tipo: 'recorrente_nao_lancada', rotulo: 'Despesa recorrente não lançada', area: 'financeiro', origem: 'condominio' },
  { tipo: 'sem_nota_fiscal', rotulo: 'Pagamento sem nota fiscal (Dashboard)', area: 'financeiro', origem: 'condominio' },
  { tipo: 'fin_sem_comprovante', rotulo: 'Pago sem comprovante', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'fin_sem_nota', rotulo: 'Pago sem nota fiscal', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'fin_vencida', rotulo: 'Vencida sem baixa', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'fin_duplicidade', rotulo: 'Duplicidade', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'fin_lancamento_tardio', rotulo: 'Lançada depois do vencimento', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'fin_anexo_tardio', rotulo: 'Anexo atrasado', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'fin_pago_atraso', rotulo: 'Paga depois do vencimento sem juros', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'fin_mexida', rotulo: 'Mexida suspeita', area: 'financeiro', origem: 'financeiro' },
  { tipo: 'manutencao_atrasada', rotulo: 'Manutenção periódica atrasada', area: 'operacional', origem: 'condominio' },
  { tipo: 'consumo_fora_padrao', rotulo: 'Consumo fora do padrão', area: 'operacional', origem: 'condominio' },
  { tipo: 'certidao_vencendo', rotulo: 'Certidão vencendo', area: 'documentos', origem: 'condominio' },
  { tipo: 'certidao_vencida', rotulo: 'Certidão vencida', area: 'documentos', origem: 'condominio' },
  { tipo: 'mandato_vencendo', rotulo: 'Mandato vencendo', area: 'documentos', origem: 'condominio' },
  { tipo: 'advertencia_vencida', rotulo: 'Advertência com prazo vencido', area: 'documentos', origem: 'condominio' },
  { tipo: 'alerta_uso', rotulo: 'Alertas de uso', area: 'seguranca', origem: 'seguranca' },
];
const TIPO = new Map(TIPOS.map((t) => [t.tipo, t]));

// Tipos das regras do painel Financeiro (financeiro/regras/alerta.js) e do Seu dia para a chave
// da preferência. Duplicidade junta os dois R1 e o condomínio trocado (mesmo código de barras ou
// nota); mexida suspeita junta a R9 e o anexo removido, como o pré balancete já agrupa.
const MAPA_FIN = {
  R1_DOCUMENTO: 'fin_duplicidade', R1_FORNECEDOR_VALOR: 'fin_duplicidade', R2_CONDOMINIO_TROCADO: 'fin_duplicidade',
  R4_SEM_COMPROVANTE: 'fin_sem_comprovante', R4_ANEXO_REMOVIDO: 'fin_mexida', R5_SEM_NOTA: 'fin_sem_nota',
  R6_VENCIDA: 'fin_vencida', R8_LANCAMENTO_TARDIO: 'fin_lancamento_tardio', R8_ANEXO_TARDIO: 'fin_anexo_tardio',
  R8_PAGO_ATRASO: 'fin_pago_atraso', R9_MEXIDA: 'fin_mexida',
  vencidas: 'fin_vencida', // item do Seu dia (resumo da carteira)
};
// Chave da preferência de um tipo qualquer (null = tipo sem botão próprio; só "Pausar todos" pega).
function chavePreferencia(tipo) {
  const t = String(tipo || '');
  if (TIPO.has(t)) return t;
  return MAPA_FIN[t] || null;
}

// Gravidade dos alertas do Dashboard (a tabela não guarda gravidade).
const GRAVIDADE = {
  saldo_baixo: 'alta', certidao_vencida: 'alta',
  conta_a_vencer: 'media', recorrente_nao_lancada: 'media', sem_nota_fiscal: 'media', manutencao_atrasada: 'media',
  certidao_vencendo: 'media', mandato_vencendo: 'media', advertencia_vencida: 'media',
  consumo_fora_padrao: 'baixa',
};
// Alertas de uso: tentativa de passar da permissão ou mexer em outro condomínio pesa mais.
const GRAVIDADE_USO = {
  fora_da_carteira: 'alta', tentou_liberar_acesso_restrito: 'alta', usuario_bloqueado: 'alta',
  relatorio_de_outro_condominio: 'alta', transcricao_de_outro_condominio: 'alta', condominio_fora_da_base: 'alta',
  acesso_negado: 'media', modulo_sem_acesso: 'media', volume_alto: 'media', fora_do_horario: 'media',
  caminho_antigo_fechado: 'media', transcricao_sem_condominio: 'media',
};
const PESO = { alta: 3, media: 2, baixa: 1 };
const ORDEM_STATUS = { novo: 0, visto: 1, resolvido: 2 };

const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const moeda = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── permissão ─────────────────────────────────────────────────────────────
// Ver: liberado para todos por padrão (como o Dashboard). Só some para quem o dono desmarcou
// "Visível" no módulo. Perfil ilegível: não vê (quem chama responde 503).
function podeVerCentral(perfil) {
  if (!perfil) return false;
  if (perfil.role === 'GESTOR') return true;
  const m = perfil.permissoes && perfil.permissoes[MODULO];
  return !(m && m.visivel === false);
}
// Silenciar: GESTOR sempre; os outros só com a ação liberada (mesma regra do segunda_via da T18).
function podeSilenciar(perfil) {
  if (!perfil) return false;
  if (perfil.role === 'GESTOR') return true;
  const m = perfil.permissoes && perfil.permissoes[MODULO];
  return !!(m && m.visivel === true && Array.isArray(m.acoes) && m.acoes.includes('silenciar'));
}

// ── preferências ──────────────────────────────────────────────────────────
const VAZIA = Object.freeze({ silenciados: [], pausado: false });
const _cachePref = new Map(); // userId -> { ate, v }
function limparPref(p) {
  const s = Array.isArray(p && p.silenciados) ? p.silenciados.filter((x) => TIPO.has(String(x))).map(String) : [];
  return { silenciados: [...new Set(s)], pausado: !!(p && p.pausado === true) };
}
// Lê do banco com cache curto. Falha de leitura vira "nada silenciado" (mostrar a mais é o lado
// seguro) e não fica em cache por muito tempo.
async function lerPreferencias(banco, userId) {
  if (!UUID.test(String(userId || ''))) return VAZIA;
  const k = String(userId).toLowerCase();
  const c = _cachePref.get(k);
  if (c && c.ate > Date.now()) return c.v;
  let v = VAZIA, ttl = 5000;
  try {
    const r = await banco('GET', '/rest/v1/alertas_preferencias?user_id=eq.' + k + '&select=silenciados,pausado&limit=1');
    if (r.status === 200 && Array.isArray(r.body)) { v = r.body[0] ? limparPref(r.body[0]) : VAZIA; ttl = CACHE_PREF_MS; }
  } catch (e) { /* fica a vazia */ }
  _cachePref.set(k, { ate: Date.now() + ttl, v });
  if (_cachePref.size > 500) _cachePref.delete(_cachePref.keys().next().value);
  return v;
}
function esquecerPreferencias(userId) { if (userId) _cachePref.delete(String(userId).toLowerCase()); }

// Preferência que vale para este pedido: null para quem não pode silenciar (vê tudo) ou para
// o acesso interno (sem pessoa).
async function preferenciasDoPedido(req, deps) {
  if (!req || req.authMode === 'internal') return null;
  const uid = req.user && req.user.sub;
  if (!UUID.test(String(uid || ''))) return null;
  let perfil = null;
  try { perfil = await deps.perfilDe(req); } catch (e) { perfil = null; }
  if (!podeSilenciar(perfil)) return null;
  return lerPreferencias(deps.banco, uid);
}
const temEfeito = (p) => !!(p && (p.pausado || (p.silenciados && p.silenciados.length)));
const estaSilenciado = (tipo, p, set) => !!(p && (p.pausado || set.has(chavePreferencia(tipo))));

// Marca silenciado:true nos alertas dos tipos silenciados (ou em todos, se pausado). Não muda o
// objeto recebido (a base do Financeiro é compartilhada entre pessoas): devolve cópias marcadas.
function aplicarPreferencias(alertas, prefs) {
  if (!Array.isArray(alertas) || !temEfeito(prefs)) return alertas;
  const set = new Set(prefs.silenciados || []);
  return alertas.map((a) => (a && estaSilenciado(a.tipo, prefs, set) ? Object.assign({}, a, { silenciado: true }) : a));
}
// Tipos (como vieram, ex.: R6_VENCIDA) que ficam silenciados, para respostas que só têm contagem.
function tiposSilenciados(tipos, prefs) {
  if (!temEfeito(prefs)) return [];
  const set = new Set(prefs.silenciados || []);
  return [...new Set(tipos || [])].filter((t) => estaSilenciado(t, prefs, set));
}

// Quadro da carteira do painel Financeiro (/api/financeiro/resumo): só tem contagem por tipo.
// Marca silenciado:true em condominios[i].por_tipo[tipo] e põe tipos_silenciados na raiz. Não
// desconta nada de total, por_gravidade nem valor_alta (a tela desconta; aqui duplicaria).
function marcarResumoFinanceiro(resumo, prefs) {
  if (!resumo || !Array.isArray(resumo.condominios)) return resumo;
  const vistos = [];
  resumo.condominios.forEach((c) => Object.keys(c.por_tipo || {}).forEach((t) => vistos.push(t)));
  const silenciados = tiposSilenciados(vistos, prefs);
  if (silenciados.length) {
    const set = new Set(silenciados);
    resumo.condominios.forEach((c) => Object.keys(c.por_tipo || {}).forEach((t) => {
      if (set.has(t)) c.por_tipo[t] = Object.assign({}, c.por_tipo[t], { silenciado: true });
    }));
  }
  resumo.tipos_silenciados = silenciados;
  return resumo;
}

// ── formato da Central ────────────────────────────────────────────────────
// Resumo curto a partir do detalhe gravado pelo Dashboard (cada tipo grava campos diferentes).
const CAMPOS_RESUMO = ['fornecedor', 'descricao', 'conta', 'vencimento', 'prevista_para', 'valor', 'valor_ultimo', 'saldo', 'limite', 'unidade', 'cargo', 'nome', 'validade', 'ultima', 'dias'];
const DINHEIRO = new Set(['valor', 'valor_ultimo', 'saldo', 'limite']);
function resumoDetalhe(d) {
  if (!d || typeof d !== 'object') return '';
  const partes = [];
  for (const k of CAMPOS_RESUMO) {
    const v = d[k];
    if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
    partes.push(DINHEIRO.has(k) && isFinite(Number(v)) ? moeda(v) : txt(v, 80));
    if (partes.length >= 4) break;
  }
  return partes.join(' · ').slice(0, 240);
}
// Tela do Hub onde o alerta do condomínio se resolve (a Central usa como link quando não há URL).
const TELA = { certidao_vencendo: 'prestacao', certidao_vencida: 'prestacao', mandato_vencendo: 'regras', advertencia_vencida: 'regras' };
function areaDoTipo(tipo) { const t = TIPO.get(tipo); return t ? t.area : 'operacional'; }
function rotuloDoTipo(tipo, reserva) { const t = TIPO.get(tipo); return t ? t.rotulo : txt(reserva || tipo, 80); }

function deCondominio(l, nome) {
  let grav = GRAVIDADE[l.tipo] || 'media';
  // Mandato já vencido (a chave guarda o estado) pesa mais que o que ainda vai vencer.
  if (l.tipo === 'mandato_vencendo' && /:vencido$/.test(String(l.chave || ''))) grav = 'alta';
  return {
    origem: 'condominio', area: areaDoTipo(l.tipo), tipo: l.tipo, rotulo: rotuloDoTipo(l.tipo), gravidade: grav,
    id_superlogica: Number(l.id_superlogica), condominio: nome, titulo: txt(l.titulo, 300), resumo: resumoDetalhe(l.detalhe),
    status: l.status || 'novo', alerta_id: l.id || null, chave: String(l.chave || ''), link: TELA[l.tipo] || 'dashboard',
    data: l.criado_em || null, silenciado: false,
  };
}
function deFinanceiro(a, id, nome) {
  const tipo = MAPA_FIN[a.tipo] || String(a.tipo || '').toLowerCase();
  const resumo = [a.fornecedor, a.valor ? moeda(a.valor) : '', a.dt_vencimento ? 'vencimento ' + a.dt_vencimento.split('-').reverse().join('/') : '', a.detalhe]
    .filter(Boolean).map((x) => txt(x, 120)).join(' · ').slice(0, 240);
  return {
    origem: 'financeiro', area: 'financeiro', tipo, tipo_original: a.tipo, rotulo: rotuloDoTipo(tipo, a.descricao_tipo),
    gravidade: PESO[a.gravidade] ? a.gravidade : 'media', id_superlogica: Number(id), condominio: nome,
    titulo: txt(a.descricao_tipo || a.tipo, 200), resumo, status: 'novo', alerta_id: null,
    chave: 'fin:' + a.tipo + ':' + (a.id_parcela || a.id_despesa || '') + ':' + (a.quando || ''),
    link: /^https:\/\//.test(String(a.link || '')) ? a.link : 'financeiro',
    data: a.dt_vencimento || a.dt_liquidacao || (a.quando ? String(a.quando).slice(0, 10) : null), silenciado: false,
  };
}
function deSeguranca(g) {
  const vezes = Number(g.vezes) || 1;
  return {
    origem: 'seguranca', area: 'seguranca', tipo: 'alerta_uso', tipo_original: g.tipo, rotulo: 'Alertas de uso',
    gravidade: GRAVIDADE_USO[g.tipo] || 'baixa', id_superlogica: null, condominio: txt(g.condominio, 120),
    titulo: txt(g.titulo, 200), resumo: [txt(g.email, 120), vezes > 1 ? vezes + ' vezes' : ''].filter(Boolean).join(' · '),
    status: 'novo', alerta_id: null, chave: 'uso:' + g.tipo + ':' + (g.email || '') + ':' + (g.transcricao_id || ''), link: 'seguranca',
    data: g.ultima || null, silenciado: false,
  };
}

function contar(alertas, comSeguranca) {
  const areas = AREAS.filter((a) => comSeguranca || a.area !== 'seguranca').map((a) => ({ area: a.area, nome: a.nome, total: 0, alta: 0, media: 0, baixa: 0, silenciados: 0 }));
  const por = new Map(areas.map((a) => [a.area, a]));
  for (const a of alertas) {
    const c = por.get(a.area);
    if (!c || a.status === 'resolvido') continue;
    if (a.silenciado) { c.silenciados++; continue; }
    c.total++; c[a.gravidade] = (c[a.gravidade] || 0) + 1;
  }
  return areas;
}

// ── fila do cálculo em segundo plano ──────────────────────────────────────
// Um condomínio por vez (cada cálculo faz dezenas de leituras no Superlógica), com teto de tempo.
// Estourou o teto: segue para o próximo e tenta aquele de novo em 30 minutos.
function criarFila({ calcular, agora, tetoMs, log }) {
  const calculos = new Map(); // id -> { em, chaves: Set | null, parcial, falhou }
  const fila = [];
  const naFila = new Set();
  let rodando = null;

  function registrar(id, calc) {
    const falhas = (calc && Array.isArray(calc.falhas)) ? calc.falhas : [];
    const chaves = (calc && Array.isArray(calc.alertas)) ? calc.alertas.map((a) => String(a.chave)) : [];
    // Cálculo com falha de leitura não serve para dizer que um alerta guardado já passou.
    calculos.set(String(id), { em: agora(), chaves: falhas.length ? null : new Set(chaves), parcial: falhas.length > 0, falhou: false });
  }
  function idade(id) { const c = calculos.get(String(id)); return c ? agora() - c.em : Infinity; }
  function precisa(id, forcar) {
    const c = calculos.get(String(id));
    if (!c) return true;
    if (forcar) return agora() - c.em > FORCAR_MIN_MS;
    return agora() - c.em > (c.parcial || c.falhou ? TENTAR_DE_NOVO_MS : SEIS_HORAS);
  }
  async function girar() {
    if (rodando) return;
    while (fila.length) {
      const id = fila.shift();
      naFila.delete(id);
      rodando = id;
      let timer = null;
      const teto = new Promise((ok) => { timer = setTimeout(() => ok('teto'), tetoMs); if (timer.unref) timer.unref(); });
      try {
        const r = await Promise.race([Promise.resolve().then(() => calcular(id)), teto]);
        if (r === 'teto') {
          calculos.set(id, { em: agora(), chaves: null, parcial: false, falhou: true });
          log('[central-alertas] ' + id + ' passou do teto de ' + Math.round(tetoMs / 1000) + 's');
        } else registrar(id, r && r.calc ? r.calc : r);
      } catch (e) {
        calculos.set(id, { em: agora(), chaves: null, parcial: false, falhou: true });
        log('[central-alertas] ' + id + ' falhou: ' + (e && e.message));
      } finally { clearTimeout(timer); }
    }
    rodando = null;
  }
  // Põe na fila quem precisa; devolve quantos estão esperando ou rodando.
  function agendar(ids, forcar) {
    for (const id of ids) {
      const k = String(id);
      if (naFila.has(k) || rodando === k || !precisa(k, forcar)) continue;
      fila.push(k); naFila.add(k);
    }
    if (fila.length && !rodando) setImmediate(() => { girar().catch(() => { rodando = null; }); });
    return fila.length + (rodando ? 1 : 0);
  }
  const ocupada = () => fila.length > 0 || !!rodando;
  return { registrar, agendar, ocupada, idade, calculos, ultimo: (id) => calculos.get(String(id)) || null };
}

// ── rotas ─────────────────────────────────────────────────────────────────
// deps: { requireAuth, express, banco, perfilDe, escopo, gruposCarteiras, podeLerSuperlogica,
//         podeCalcular, calcularEGravar, painelFin, temFinanceiro, nivelAuditoria, alertasUso,
//         agora?, tetoMs?, esperaFinMs?, log? }
function criarRotasCentral(app, deps) {
  const { requireAuth, express, banco } = deps;
  const agora = deps.agora || (() => Date.now());
  const log = deps.log || ((m) => console.warn(m));
  const esperaFin = deps.esperaFinMs || ESPERA_FIN_PADRAO_MS;
  const fila = criarFila({ calcular: (id) => deps.calcularEGravar(id), agora, tetoMs: deps.tetoMs || TETO_PADRAO_MS, log });
  const uid = (req) => { const u = req.user && req.user.sub; return UUID.test(String(u || '')) ? String(u).toLowerCase() : null; };

  let cacheCond = null; // { ate, mapa: Map(id -> nome) }
  async function nomesCondominios() {
    if (cacheCond && cacheCond.ate > agora()) return cacheCond.mapa;
    const r = await banco('GET', '/rest/v1/condominios?select=id_superlogica,nome&id_superlogica=not.is.null&limit=3000');
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('condominios_' + r.status);
    const mapa = new Map();
    r.body.forEach((c) => { if (ID_SL.test(String(c.id_superlogica))) mapa.set(String(c.id_superlogica), txt(c.nome, 120)); });
    cacheCond = { ate: agora() + CACHE_COND_MS, mapa };
    return mapa;
  }

  // Linhas da tabela alertas dos condomínios pedidos (em lotes, para a URL não crescer demais).
  async function lerTabela(ids, comResolvidos) {
    const out = [];
    const campos = '&select=id,id_superlogica,chave,tipo,titulo,detalhe,status,criado_em,atualizado_em';
    for (let i = 0; i < ids.length; i += 100) {
      const lote = 'id_superlogica=in.(' + ids.slice(i, i + 100).join(',') + ')';
      const r = await banco('GET', '/rest/v1/alertas?' + lote + '&status=in.(novo,visto)' + campos + '&order=criado_em.desc&limit=3000');
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('alertas_' + r.status);
      out.push(...r.body);
      if (comResolvidos) {
        const desde = new Date(agora() - DIAS_RESOLVIDOS * 86400000).toISOString();
        const r2 = await banco('GET', '/rest/v1/alertas?' + lote + '&status=eq.resolvido&atualizado_em=gte.' + encodeURIComponent(desde) + campos + '&order=atualizado_em.desc&limit=2000');
        if (r2.status !== 200 || !Array.isArray(r2.body)) throw new Error('alertas_' + r2.status);
        out.push(...r2.body);
      }
    }
    return out;
  }

  // Base do Financeiro sem segurar a resposta: espera alguns segundos e segue.
  async function baseFinanceiro(forcar) {
    let timer = null;
    const tempo = new Promise((ok) => { timer = setTimeout(() => ok('tempo'), esperaFin); if (timer.unref) timer.unref(); });
    const p = Promise.resolve().then(() => deps.painelFin.obterBase(forcar));
    p.catch(() => {});
    try { return await Promise.race([p, tempo]); } finally { clearTimeout(timer); }
  }

  async function perfilOuNada(req, res) {
    let perfil = null;
    try { perfil = await deps.perfilDe(req); } catch (e) { perfil = null; }
    if (!perfil) { res.status(503).json({ erro: 'permissao_indisponivel', detalhe: 'Não foi possível conferir suas permissões agora.' }); return null; }
    return perfil;
  }
  async function nivelDe(req) { try { return await deps.nivelAuditoria(req); } catch (e) { return null; } }
  const interno = (req) => req.authMode === 'internal';
  const veFinanceiro = (req, perfil) => interno(req) || deps.temFinanceiro(perfil, 'ver');

  // ── GET /api/central-alertas ─────────────────────────────────────────────
  app.get('/api/central-alertas', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const perfil = await perfilOuNada(req, res);
    if (!perfil) return;
    if (!interno(req) && !podeVerCentral(perfil)) return res.status(403).json({ erro: 'modulo_sem_acesso', detalhe: 'Seu usuário não tem acesso à Central de alertas.' });
    const carteira = txt(req.query.carteira, 80);
    const forcar = req.query.forcar === '1';
    const comResolvidos = req.query.resolvidos === '1' || /resolvido/.test(String(req.query.situacao || ''));

    let esc;
    try { esc = await deps.escopo(req); } catch (e) {
      return res.status(503).json({ erro: 'carteira_indisponivel', detalhe: 'Não foi possível conferir sua carteira agora. Tente de novo em instantes.' });
    }
    const falhas = [];
    let nomes = new Map();
    try { nomes = await nomesCondominios(); } catch (e) { falhas.push('Lista de condomínios'); }

    // Condomínios que a pessoa vê: todos (GESTOR, todas_carteiras, sem carteira) ou os da carteira.
    let ids;
    if (esc.todas) {
      ids = new Set(nomes.keys());
      if (!ids.size) {
        try { (await deps.gruposCarteiras()).forEach((g) => (g.condominios || []).forEach((c) => ids.add(String(c)))); } catch (e) { /* fica vazio */ }
      }
    } else ids = new Set((esc.ids_superlogica || []).map(String));
    // Filtro de uma carteira (pelo código ou pelo nome), sempre dentro do que a pessoa já vê.
    if (carteira && norm(carteira) !== 'meus') {
      let grupos;
      try { grupos = await deps.gruposCarteiras(); } catch (e) {
        return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler as carteiras agora.' });
      }
      const g = (grupos || []).find((x) => String(x.id) === carteira || norm(x.nome) === norm(carteira));
      if (!g) return res.status(404).json({ erro: 'carteira_nao_encontrada', detalhe: 'Essa carteira não existe mais.' });
      const daCarteira = new Set((g.condominios || []).map(String));
      ids = new Set([...ids].filter((x) => daCarteira.has(x)));
    }
    EXCLUIDOS.forEach((x) => ids.delete(x));
    const lista = [...ids].filter((x) => ID_SL.test(x)).sort((a, b) => a - b);
    const nomeDe = (id, reserva) => nomes.get(String(id)) || txt(reserva, 120) || 'Condomínio ' + id;

    const prefs = interno(req) || !podeSilenciar(perfil) ? null : await lerPreferencias(banco, uid(req));
    const leSL = await Promise.resolve().then(() => deps.podeLerSuperlogica(req)).catch(() => false);
    let alertas = [];
    let atualizando = false;

    // 1. condomínio (tabela alertas + fila em segundo plano)
    if (leSL && lista.length) {
      try {
        const linhas = await lerTabela(lista, comResolvidos);
        for (const l of linhas) {
          const c = fila.ultimo(l.id_superlogica);
          if (c && c.chaves && !c.chaves.has(String(l.chave))) continue; // já não vale (o último cálculo não achou)
          alertas.push(deCondominio(l, nomeDe(l.id_superlogica)));
        }
      } catch (e) {
        log('[central-alertas] tabela falhou: ' + (e && e.message));
        falhas.push('Alertas dos condomínios');
      }
      let podeCalc = false;
      try { podeCalc = !!deps.podeCalcular(); } catch (e) { podeCalc = false; }
      if (podeCalc && fila.agendar(lista, forcar) > 0) atualizando = true;
    } else if (!leSL) falhas.push('Sem acesso aos dados do Superlógica');

    // 2. financeiro (só com o módulo)
    if (leSL && veFinanceiro(req, perfil)) {
      try {
        const base = await baseFinanceiro(forcar);
        if (base === 'tempo' || !base) atualizando = true;
        else {
          const restrito = !esc.todas;
          const doFin = new Set(lista);
          // Quem vê todos também recebe condomínio que só aparece nas despesas (fora da tabela).
          if (esc.todas && !(carteira && norm(carteira) !== 'meus')) for (const id of base.condominios.keys()) if (ID_SL.test(String(id)) && !EXCLUIDOS.has(String(id))) doFin.add(String(id));
          for (const id of doFin) {
            const r = deps.painelFin.alertasDoCondominio(base, id, restrito);
            for (const a of r.alertas || []) alertas.push(deFinanceiro(a, id, nomeDe(id, r.nome)));
          }
          if (deps.painelFin.situacao && deps.painelFin.situacao().calculando) atualizando = true;
        }
      } catch (e) {
        log('[central-alertas] financeiro falhou: ' + (e && e.message));
        falhas.push('Alertas do Financeiro');
      }
    }

    // 3. segurança (só ver_auditoria ou auditoria_total)
    const nivel = await nivelDe(req);
    if (nivel) {
      try {
        const l = await deps.alertasUso(req, nivel);
        if (!Array.isArray(l)) throw new Error('sem_lista');
        l.forEach((g) => alertas.push(deSeguranca(g)));
      } catch (e) { falhas.push('Alertas de uso'); }
    }

    if (prefs) alertas = aplicarPreferencias(alertas, prefs);
    alertas.sort((a, b) => (ORDEM_STATUS[a.status] - ORDEM_STATUS[b.status]) || (PESO[b.gravidade] - PESO[a.gravidade])
      || String(b.data || '').localeCompare(String(a.data || '')) || String(a.condominio).localeCompare(String(b.condominio)));
    const cortados = Math.max(0, alertas.length - MAX_ALERTAS);
    if (cortados) alertas = alertas.slice(0, MAX_ALERTAS);

    res.json({
      gerado_em: new Date(agora()).toISOString(), atualizando,
      pode_silenciar: !interno(req) && podeSilenciar(perfil), pausado: !!(prefs && prefs.pausado),
      condominios: lista.map((id) => ({ id_superlogica: Number(id), nome: nomeDe(id) })),
      areas: contar(alertas, !!nivel), alertas, falhas, cortados,
    });
  });

  // ── preferências ─────────────────────────────────────────────────────────
  // Tipos que a pessoa enxerga (financeiro e segurança dependem de permissão).
  async function tiposVisiveis(req, perfil) {
    const nivel = await nivelDe(req);
    const fin = veFinanceiro(req, perfil);
    return TIPOS.filter((t) => (t.origem !== 'financeiro' || fin) && (t.origem !== 'seguranca' || nivel))
      .map((t) => ({ tipo: t.tipo, rotulo: t.rotulo, area: t.area }));
  }

  app.get('/api/alertas/preferencias', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const perfil = await perfilOuNada(req, res);
    if (!perfil) return;
    const pode = !interno(req) && !!uid(req) && podeSilenciar(perfil);
    const p = pode ? await lerPreferencias(banco, uid(req)) : VAZIA;
    res.json({ pode_silenciar: pode, silenciados: p.silenciados, pausado: p.pausado, tipos: await tiposVisiveis(req, perfil) });
  });

  app.put('/api/alertas/preferencias', requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const perfil = await perfilOuNada(req, res);
    if (!perfil) return;
    const id = uid(req);
    if (interno(req) || !id || !podeSilenciar(perfil)) {
      return res.status(403).json({ erro: 'acesso_negado', detalhe: 'Seu usuário não pode silenciar alertas.' });
    }
    const b = req.body || {};
    if (!Array.isArray(b.silenciados) || b.silenciados.length > 60 || !b.silenciados.every((x) => typeof x === 'string' && TIPO.has(x))) {
      return res.status(400).json({ erro: 'tipos_invalidos', detalhe: 'Algum tipo de alerta não existe.' });
    }
    if (b.pausado !== undefined && typeof b.pausado !== 'boolean') return res.status(400).json({ erro: 'pausado_invalido' });
    const linha = { silenciados: [...new Set(b.silenciados)], pausado: b.pausado === true, atualizado_em: new Date(agora()).toISOString() };
    try {
      let r = await banco('PATCH', '/rest/v1/alertas_preferencias?user_id=eq.' + id, linha);
      if (r.status === 200 && Array.isArray(r.body) && !r.body.length) r = await banco('POST', '/rest/v1/alertas_preferencias', Object.assign({ user_id: id }, linha));
      if (r.status !== 200 && r.status !== 201) {
        const semTabela = r.status === 404 || /alertas_preferencias/.test(JSON.stringify(r.body || ''));
        return res.status(503).json({ erro: 'falha_salvar', detalhe: semTabela ? 'O banco deste ambiente ainda não tem a tabela de preferências (migration 023).' : 'Não foi possível salvar suas preferências agora.' });
      }
    } catch (e) {
      return res.status(503).json({ erro: 'falha_salvar', detalhe: 'Não foi possível salvar suas preferências agora.' });
    }
    esquecerPreferencias(id);
    res.json({ pode_silenciar: true, silenciados: linha.silenciados, pausado: linha.pausado });
  });

  return {
    // O Dashboard chama depois de calcular um condomínio: a Central aproveita o resultado.
    registrarCalculo: (id, calc) => fila.registrar(String(id), calc),
    fila,
  };
}

module.exports = {
  criarRotasCentral, aplicarPreferencias, lerPreferencias, preferenciasDoPedido, esquecerPreferencias, tiposSilenciados, marcarResumoFinanceiro,
  podeVerCentral, podeSilenciar, chavePreferencia, criarFila, resumoDetalhe,
  TIPOS, MAPA_FIN, EXCLUIDOS, MODULO,
};
