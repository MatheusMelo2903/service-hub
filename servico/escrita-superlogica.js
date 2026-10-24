'use strict';
// Política única de gravação no Superlógica (decisão do Matheus, 23/10/2026): "por enquanto o Hub
// grava só no 167; depois vai poder gravar em todos, pedindo confirmação". Toda rota do Hub que
// grava no Superlógica passa por aqui antes de gravar (entrada de documentos, consumo, 2ª via,
// multa, comunicados, balancete digital e arquivamento de ata ou prestação).
//
// Interruptor geral ESCRITA_SUPERLOGICA:
//   teste (padrão)  grava sem confirmação só nos condomínios de ESCRITA_TESTE (padrão "167").
//                   Os condomínios das variáveis antigas de lista (ENTRADA_LANCAMENTO_LIBERADO,
//                   CONSUMO_LANCAMENTO_LIBERADO, COBRANCA_SEGUNDA_VIA_LIBERADA,
//                   BALANCETE_GERACAO_LIBERADA) continuam liberados, agora com confirmação.
//   confirmacao     grava em qualquer condomínio da base com confirmação explícita da pessoa
//                   naquela operação; os de teste seguem livres.
//   off             nada grava. Valor desconhecido vale como "teste" (o lado seguro).
//
// Confirmação: sem token válido a rota responde 428 { erro:'confirmacao_necessaria', resumo,
// confirmacao } com um token de uso único, válido por 10 minutos e amarrado à pessoa, à operação,
// ao condomínio e ao conteúdo (hash do pedido). A tela mostra o resumo e reenvia o mesmo pedido
// com confirmacao_gravacao { id_condominio, token, nome_digitado }.
// Operação sensível (balancete digital, comunicado, disparo, cobrança de multa, prestação, lote
// acima de 20 itens): confirmação reforçada, a pessoa digita o nome curto do condomínio. No
// condomínio de teste continua livre.
// Lote (consumo): um token cobre a lista conferida e cada item só grava uma vez.
// Toda gravação e toda recusa vão para a auditoria do Hub. O token nunca vai para log nem auditoria.
// 143, 144, 145, 160 e 162 são cadastros da administração: nunca gravam por aqui.

const crypto = require('crypto');

const NUNCA = new Set(['143', '144', '145', '160', '162']);
const MODOS = ['teste', 'confirmacao', 'off'];
const VALIDADE_MS = 10 * 60 * 1000;
const LIMITE_LOTE = 20;
const MAX_TOKENS = 5000;
const MAX_TENTATIVAS_NOME = 3;
const ID = /^[1-9]\d{0,8}$/;

// legado: variável antiga de lista; chave: variável antiga liga/desliga (1 libera).
const OPERACOES = {
  entrada_lancar: { rotulo: 'Lançamento de despesa', legado: 'ENTRADA_LANCAMENTO_LIBERADO' },
  entrada_lote: { rotulo: 'Lançamento de despesas em lote', legado: 'ENTRADA_LANCAMENTO_LIBERADO' },
  consumo_lote: { rotulo: 'Lançamento de leituras de consumo', legado: 'CONSUMO_LANCAMENTO_LIBERADO', porItem: true },
  segunda_via: { rotulo: 'Geração da 2ª via do boleto', legado: 'COBRANCA_SEGUNDA_VIA_LIBERADA' },
  multa_registrar: { rotulo: 'Registro de ocorrência ou multa na unidade' },
  comunicado_publicar: { rotulo: 'Publicação de comunicado para os moradores', sensivel: true },
  comunicado_disparar: { rotulo: 'Disparo dos comunicados pendentes de todos os condomínios', sensivel: true, global: true, chave: 'COMUNICADOS_DISPARO_LIBERADO' },
  balancete_gerar: { rotulo: 'Geração do balancete digital (900A)', legado: 'BALANCETE_GERACAO_LIBERADA', sensivel: true },
  documento_arquivar: { rotulo: 'Arquivamento de documento no Superlógica' },
  // Conciliação do dia: extratos (só dias novos) e lançamentos já pagos de um condomínio. Um pedido
  // cobre a lista conferida; acima de 20 itens a confirmação é reforçada.
  conciliacao_gravar: { rotulo: 'Gravação da conciliação do dia (extratos e lançamentos já pagos)' },
  // Ponte genérica /api/superlogica (importação de unidades e despesas pela tela): cada POST, PUT
  // ou DELETE gasta uma unidade da cota confirmada. Cota acima de 1 envio é lote: confirmação reforçada.
  ponte_superlogica: { rotulo: 'Importação direta no Superlógica', cota: true },
};
// Caminhos da ponte que a tela pode confirmar fora do condomínio de teste (o resto só no teste).
const CAMINHOS_PONTE = { 'unidades/post': 'Cadastro de unidades e moradores', despesas: 'Lançamento de despesas' };

const DETALHE_BLOQUEIO = {
  escrita_desligada: 'A gravação no Superlógica pelo Hub está desligada pela administração. Nada foi gravado.',
  so_teste: 'Por enquanto o Hub só grava no Superlógica nos condomínios de teste. Faça esta operação direto no Superlógica.',
  nao_condominio: 'Esse cadastro não é um condomínio. Nada foi gravado.',
  operacao_travada: 'Esta operação está travada pela administração. Nada foi gravado.',
  fora_da_base: 'Esse condomínio não está na base do Hub. Nada foi gravado.',
  operacao_desconhecida: 'Operação de gravação desconhecida. Nada foi gravado.',
};

function lerIds(v) {
  return [...new Set(String(v == null ? '' : v).split(/[\s,;]+/).filter((x) => ID.test(x) && !NUNCA.has(x)))];
}
function modo(env) {
  const v = String((env && env.ESCRITA_SUPERLOGICA) || '').trim().toLowerCase();
  return MODOS.includes(v) ? v : 'teste';
}
function condominiosTeste(env) {
  const v = env && env.ESCRITA_TESTE;
  return new Set(v == null || String(v).trim() === '' ? ['167'] : lerIds(v));
}
// Lista antiga só conta quando foi definida de propósito (o padrão "167" dela já é o de teste).
function legados(operacao, env) {
  const d = OPERACOES[operacao];
  if (!d || !d.legado) return new Set();
  const v = env && env[d.legado];
  if (v == null || String(v).trim() === '') return new Set();
  return new Set(lerIds(v));
}

// Situação de uma operação num condomínio, sem ler nada fora (serve também para a tela).
// Devolve { estado: livre | confirmacao | reforcada | bloqueado, motivo?, modo }.
function situacao(operacao, idCondominio, extra, env) {
  const d = OPERACOES[operacao];
  const m = modo(env);
  if (!d) return { estado: 'bloqueado', motivo: 'operacao_desconhecida', modo: m };
  if (m === 'off') return { estado: 'bloqueado', motivo: 'escrita_desligada', modo: m };
  const sensivel = !!(d.sensivel || (extra && extra.sensivel) || (extra && Number(extra.quantidade) > LIMITE_LOTE));
  const comConfirmacao = sensivel ? 'reforcada' : 'confirmacao';
  if (d.global) return env && env[d.chave] === '1' ? { estado: 'reforcada', modo: m } : { estado: 'bloqueado', motivo: 'operacao_travada', modo: m };
  const id = String(idCondominio == null ? '' : idCondominio);
  if (!ID.test(id) || NUNCA.has(id)) return { estado: 'bloqueado', motivo: 'nao_condominio', modo: m };
  if (condominiosTeste(env).has(id)) return { estado: 'livre', modo: m, teste: true };
  if (m === 'confirmacao' || legados(operacao, env).has(id)) return { estado: comConfirmacao, modo: m };
  return { estado: 'bloqueado', motivo: 'so_teste', modo: m };
}

// Nome que a pessoa digita na confirmação reforçada: o nome sem "Condomínio", "Residencial" etc.,
// até duas palavras que contam ("Residencial Teste" vira "Teste").
const PREFIXO = /^(condom[ií]nio|cond\.?|residencial|resid\.?|res\.?|edif[ií]cio|ed\.?|associa[cç][aã]o|conjunto|loteamento)\s+/i;
const LIGA = /^(do|da|dos|das|de|e|&)$/i;
function nomeCurto(nome) {
  let s = String(nome || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4 && PREFIXO.test(s); i++) s = s.replace(PREFIXO, '');
  const palavras = s.split(' ').filter(Boolean);
  while (palavras.length && LIGA.test(palavras[0])) palavras.shift();
  const out = []; let contam = 0;
  for (const p of palavras) {
    if (contam >= 2) break;
    out.push(p);
    if (!LIGA.test(p)) contam++;
  }
  while (out.length && LIGA.test(out[out.length - 1])) out.pop();
  return out.join(' ') || String(nome || '').trim();
}
function normalizar(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// JSON com chaves em ordem: o mesmo pedido sempre dá o mesmo hash.
function canonico(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
}
const hashDe = (v) => crypto.createHash('sha256').update(canonico(v)).digest('hex');

// Resumo guardado na auditoria: só texto curto, nunca o conteúdo inteiro.
function resumoCurto(r) {
  if (!r || typeof r !== 'object') return null;
  const linhas = Array.isArray(r.linhas) ? r.linhas.slice(0, 15).map((l) => ({ rotulo: String((l && l.rotulo) || '').slice(0, 60), valor: String(l && l.valor != null ? l.valor : '').slice(0, 200) })) : [];
  return { linhas, quantidade: r.quantidade != null ? Number(r.quantidade) || 0 : undefined };
}

// deps: auditar(req, acao, detalhe, suspeito, motivo); condominioDaBase(id) -> { nome } | null;
// env() -> variáveis (padrão process.env); agora() -> ms (testes).
function criarPoliticaEscrita(deps) {
  const lerEnv = () => (deps && deps.env ? deps.env() : process.env);
  const agora = () => (deps && deps.agora ? deps.agora() : Date.now());
  const auditar = (req, acao, det, susp, motivo) => { try { if (deps && deps.auditar) deps.auditar(req, acao, det, !!susp, motivo); } catch (e) { /* auditoria nunca derruba a gravação */ } };
  const tokens = new Map(); // token -> registro

  const usuarioDe = (req) => (req.authMode === 'internal' ? 'interno' : String((req.user && req.user.sub) || ''));

  // Tira do mapa os tokens vencidos há mais de 10 minutos. O token fica guardado mais 10 minutos
  // depois de vencer de propósito: assim um reenvio atrasado recebe "vencido" ou "já usado" (e a
  // recusa vai para a auditoria) em vez de parecer um token desconhecido. Teto de MAX_TOKENS.
  function limpar() {
    const t = agora();
    for (const [k, r] of tokens) if (t - r.expira > VALIDADE_MS) tokens.delete(k);
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }

  function responderBloqueio(req, res, operacao, ids, motivo, resumo) {
    auditar(req, 'gravacao_recusada', { operacao, id_superlogica: ids[0] && ID.test(ids[0]) ? ids[0] : null, condominios: ids, motivo, resumo: resumoCurto(resumo), confirmada: false }, false, motivo);
    res.status(423).json({ erro: 'gravacao_bloqueada', motivo, detalhe: DETALHE_BLOQUEIO[motivo] || DETALHE_BLOQUEIO.operacao_travada });
    return false;
  }

  // Responde 423 e devolve true quando a operação está bloqueada para o condomínio (para as rotas
  // recusarem logo no começo, antes de ler o Superlógica).
  function bloqueada(req, res, operacao, idCondominio, extra) {
    const s = situacao(operacao, idCondominio, extra, lerEnv());
    if (s.estado !== 'bloqueado') return false;
    responderBloqueio(req, res, operacao, [String(idCondominio == null ? '' : idCondominio)], s.motivo, null);
    return true;
  }

  // Confere situação e base de cada condomínio. Devolve { ids, livre, reforcada, nomes } ou null (já respondeu).
  async function preparar(req, res, p) {
    const env = lerEnv();
    const d = OPERACOES[p.operacao];
    const ids = d && d.global ? ['todos'] : [...new Set([].concat(p.id_condominio).map((x) => String(x == null ? '' : x)))].sort();
    if (!d) { responderBloqueio(req, res, p.operacao, ids, 'operacao_desconhecida', null); return null; }
    if (!ids.length) { responderBloqueio(req, res, p.operacao, ids, 'nao_condominio', null); return null; }
    let reforcada = false; let livre = true;
    for (const id of ids) {
      const s = situacao(p.operacao, d.global ? null : id, p, env);
      if (s.estado === 'bloqueado') { responderBloqueio(req, res, p.operacao, ids, s.motivo, typeof p.resumo === 'object' ? p.resumo : null); return null; }
      if (s.estado !== 'livre') livre = false;
      if (s.estado === 'reforcada') reforcada = true;
    }
    const nomes = {};
    if (!livre && !d.global) {
      for (const id of ids) {
        let c = null;
        try { c = deps && deps.condominioDaBase ? await deps.condominioDaBase(id) : null; } catch (e) {
          res.status(503).json({ erro: 'base_indisponivel', detalhe: 'Não foi possível conferir o condomínio agora. Nada foi gravado.' });
          return null;
        }
        const ehTeste = situacao(p.operacao, id, p, env).estado === 'livre';
        if (!c && !ehTeste) { responderBloqueio(req, res, p.operacao, ids, 'fora_da_base', null); return null; }
        nomes[id] = (c && c.nome) || ('Condomínio ' + id);
      }
    }
    return { ids, alvo: ids.join(','), livre, reforcada, nomes, global: !!d.global };
  }

  // Monta o resumo da janela: operação, condomínio pelo nome e as linhas que a rota mandou.
  async function montarResumo(p, prep) {
    let r = p.resumo;
    if (typeof r === 'function') { try { r = await r(); } catch (e) { r = null; } }
    r = r && typeof r === 'object' ? r : {};
    const condominios = prep.global ? [] : prep.ids.map((id) => ({ id_superlogica: Number(id), nome: prep.nomes[id] || ('Condomínio ' + id) }));
    return {
      operacao: OPERACOES[p.operacao].rotulo,
      condominio: prep.global ? 'Todos os condomínios da administração' : condominios.map((c) => c.nome).join(', '),
      condominios,
      linhas: Array.isArray(r.linhas) ? r.linhas.filter((l) => l && l.rotulo).map((l) => ({ rotulo: String(l.rotulo), valor: String(l.valor == null ? '' : l.valor) })) : [],
      quantidade: p.quantidade != null ? Number(p.quantidade) : (r.quantidade != null ? Number(r.quantidade) : undefined),
      aviso: r.aviso ? String(r.aviso) : undefined,
      sensivel: prep.reforcada,
    };
  }

  // Emite um token e responde 428 com o resumo.
  async function pedirConfirmacao(req, res, p, prep, registro, motivo) {
    limpar();
    const resumo = await montarResumo(p, prep);
    const token = crypto.randomBytes(24).toString('hex');
    const curto = prep.global || prep.ids.length > 1 ? 'TODOS' : nomeCurto(prep.nomes[prep.ids[0]]);
    tokens.set(token, Object.assign({ usuario: usuarioDe(req), operacao: p.operacao, alvo: prep.alvo, expira: agora() + VALIDADE_MS,
      reforcada: prep.reforcada, nome_curto: curto, usado: false, tentativas: 0, resumo: resumoCurto(resumo) }, registro));
    res.status(428).json({
      erro: 'confirmacao_necessaria', motivo: motivo || undefined,
      detalhe: motivo === 'token_vencido' ? 'A confirmação venceu. Confira o resumo e confirme de novo.'
        : motivo === 'conteudo_alterado' ? 'O pedido mudou depois da confirmação. Confira o resumo novo e confirme de novo.'
          : motivo === 'nome_nao_confere' ? 'O nome digitado não confere. Confira e digite de novo.'
            : 'Confirme a gravação no Superlógica.',
      resumo,
      confirmacao: { token, id_condominio: prep.alvo, expira_em: new Date(agora() + VALIDADE_MS).toISOString(), reforcada: prep.reforcada, nome_curto: prep.reforcada ? curto : undefined, validade_min: VALIDADE_MS / 60000 },
    });
    return false;
  }

  // Confere o token que veio no pedido. Devolve { rec } ou { motivo, suspeito }.
  function conferirToken(req, prep, operacao, confirmacao) {
    if (!confirmacao || typeof confirmacao !== 'object' || typeof confirmacao.token !== 'string' || !/^[0-9a-f]{48}$/.test(confirmacao.token)) return { motivo: 'sem_token' };
    const rec = tokens.get(confirmacao.token);
    if (!rec) return { motivo: 'token_invalido' };
    if (rec.usuario !== usuarioDe(req)) return { motivo: 'token_de_outro_usuario', suspeito: true, rec, chave: confirmacao.token };
    if (rec.operacao !== operacao) return { motivo: 'token_de_outra_operacao', suspeito: true, rec, chave: confirmacao.token };
    if (rec.alvo !== prep.alvo || String(confirmacao.id_condominio == null ? '' : confirmacao.id_condominio) !== prep.alvo) return { motivo: 'token_de_outro_condominio', suspeito: true, rec, chave: confirmacao.token };
    if (rec.usado) return { motivo: 'token_usado', rec, chave: confirmacao.token };
    if (agora() > rec.expira) return { motivo: 'token_vencido', rec, chave: confirmacao.token };
    return { rec, chave: confirmacao.token };
  }
  const nomeConfere = (rec, digitado) => !rec.reforcada || (normalizar(digitado) !== '' && normalizar(digitado) === normalizar(rec.nome_curto));

  // Recusa de token: audita e responde. 409 para reuso, 403 para token de outra pessoa,
  // condomínio ou operação; nos demais casos (vencido, conteúdo alterado, nome errado) um token novo.
  async function recusarToken(req, res, p, prep, r) {
    auditar(req, 'gravacao_recusada', { operacao: p.operacao, id_superlogica: ID.test(prep.ids[0]) ? prep.ids[0] : null, condominios: prep.ids, motivo: r.motivo,
      resumo: typeof p.resumo === 'object' ? resumoCurto(p.resumo) : (r.rec && r.rec.resumo) || null, confirmada: false }, !!r.suspeito, r.motivo);
    if (r.motivo === 'token_usado') {
      res.status(409).json({ erro: 'confirmacao_ja_usada', detalhe: 'Essa confirmação já foi usada. Para gravar de novo, comece outra vez. Nada foi gravado agora.' });
      return false;
    }
    if (r.suspeito) {
      if (r.chave) tokens.delete(r.chave);
      res.status(403).json({ erro: 'confirmacao_invalida', motivo: r.motivo, detalhe: 'Essa confirmação não vale para este pedido. Nada foi gravado.' });
      return false;
    }
    if (r.chave) tokens.delete(r.chave);
    return null; // quem chama emite um token novo
  }

  function autorizacao(req, p, prep, confirmada) {
    let concluida = false;
    return {
      livre: prep.livre, confirmada, operacao: p.operacao, condominios: prep.ids,
      // Registra a gravação na auditoria (uma vez). resultado: { ok, ...detalhes curtos }.
      concluir(resultado) {
        if (concluida) return; concluida = true;
        const r = resultado && typeof resultado === 'object' ? resultado : { ok: !!resultado };
        auditar(req, 'gravacao_superlogica', Object.assign({}, r, { operacao: p.operacao, id_superlogica: ID.test(prep.ids[0]) ? prep.ids[0] : null, condominios: prep.ids,
          resumo: resumoCurto(typeof p.resumo === 'object' ? p.resumo : null), confirmada, livre: prep.livre, ok: !!r.ok }), !r.ok, r.ok ? null : 'gravacao_falhou');
      },
    };
  }

  // Gravação de um pedido só. p: { operacao, id_condominio (texto ou lista), conteudo, resumo
  // (objeto { linhas:[{rotulo, valor}] } ou função async), quantidade?, sensivel? }.
  // Devolve a autorização ({ livre, confirmada, concluir }) ou false (já respondeu 423, 428, 409, 403 ou 503).
  async function autorizar(req, res, p) {
    const prep = await preparar(req, res, p);
    if (!prep) return false;
    if (prep.livre) return autorizacao(req, p, prep, false);
    const hash = hashDe({ operacao: p.operacao, alvo: prep.alvo, conteudo: p.conteudo });
    const c = req.body && req.body.confirmacao_gravacao;
    const r = conferirToken(req, prep, p.operacao, c);
    if (r.motivo === 'sem_token') return pedirConfirmacao(req, res, p, prep, { hash });
    if (r.motivo) {
      const fim = await recusarToken(req, res, p, prep, r);
      if (fim === false) return false;
      return pedirConfirmacao(req, res, p, prep, { hash }, r.motivo === 'token_invalido' ? 'token_vencido' : r.motivo);
    }
    if (r.rec.itens) return recusarToken(req, res, p, prep, { motivo: 'token_de_outra_operacao', suspeito: true, rec: r.rec, chave: r.chave });
    if (r.rec.hash !== hash) {
      await recusarToken(req, res, p, prep, { motivo: 'conteudo_alterado', rec: r.rec, chave: r.chave });
      return pedirConfirmacao(req, res, p, prep, { hash }, 'conteudo_alterado');
    }
    if (!nomeConfere(r.rec, c.nome_digitado)) {
      r.rec.tentativas++;
      auditar(req, 'gravacao_recusada', { operacao: p.operacao, id_superlogica: ID.test(prep.ids[0]) ? prep.ids[0] : null, condominios: prep.ids, motivo: 'nome_nao_confere', confirmada: false }, false, 'nome_nao_confere');
      if (r.rec.tentativas >= MAX_TENTATIVAS_NOME) { tokens.delete(r.chave); return pedirConfirmacao(req, res, p, prep, { hash }, 'nome_nao_confere'); }
      res.status(428).json({ erro: 'confirmacao_necessaria', motivo: 'nome_nao_confere', detalhe: 'O nome digitado não confere. Confira e digite de novo.',
        resumo: await montarResumo(p, prep), confirmacao: { token: r.chave, id_condominio: prep.alvo, expira_em: new Date(r.rec.expira).toISOString(), reforcada: true, nome_curto: r.rec.nome_curto, validade_min: VALIDADE_MS / 60000 } });
      return false;
    }
    r.rec.usado = true; // uso único: marcado antes de gravar
    return autorizacao(req, p, prep, true);
  }

  const chaveItem = (operacao, alvo, cabecalho, item) => hashDe({ operacao, alvo, cabecalho, item });

  // Prévia de um lote (operações porItem): sem token responde 428 com o resumo; com o token
  // confirmado responde 200 { confirmado, confirmacao } e cada item grava uma vez com esse token.
  // Condomínio de teste: 200 { livre: true }. p: { operacao, id_condominio, cabecalho, itens, resumo }.
  async function previaLote(req, res, p) {
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const q = Object.assign({}, p, { quantidade: itens.length });
    const prep = await preparar(req, res, q);
    if (!prep) return false;
    if (prep.livre) { res.json({ livre: true }); return true; }
    const hash = hashDe({ operacao: p.operacao, alvo: prep.alvo, cabecalho: p.cabecalho, itens });
    const registro = { hash, itens: new Map(itens.map((it) => [chaveItem(p.operacao, prep.alvo, p.cabecalho, it), false])), confirmado: false };
    const c = req.body && req.body.confirmacao_gravacao;
    const r = conferirToken(req, prep, p.operacao, c);
    if (r.motivo === 'sem_token') return pedirConfirmacao(req, res, q, prep, registro);
    if (r.motivo) {
      const fim = await recusarToken(req, res, q, prep, r);
      if (fim === false) return false;
      return pedirConfirmacao(req, res, q, prep, registro, r.motivo === 'token_invalido' ? 'token_vencido' : r.motivo);
    }
    if (!r.rec.itens || r.rec.hash !== hash || r.rec.confirmado) {
      await recusarToken(req, res, q, prep, { motivo: 'conteudo_alterado', rec: r.rec, chave: r.chave });
      return pedirConfirmacao(req, res, q, prep, registro, 'conteudo_alterado');
    }
    if (!nomeConfere(r.rec, c.nome_digitado)) {
      tokens.delete(r.chave);
      auditar(req, 'gravacao_recusada', { operacao: p.operacao, id_superlogica: prep.ids[0], condominios: prep.ids, motivo: 'nome_nao_confere', confirmada: false }, false, 'nome_nao_confere');
      return pedirConfirmacao(req, res, q, prep, registro, 'nome_nao_confere');
    }
    r.rec.confirmado = true;
    auditar(req, 'gravacao_lote_confirmado', { operacao: p.operacao, id_superlogica: prep.ids[0], condominios: prep.ids, quantidade: itens.length, resumo: r.rec.resumo, confirmada: true });
    res.json({ confirmado: true, confirmacao: { token: r.chave, id_condominio: prep.alvo, expira_em: new Date(r.rec.expira).toISOString() } });
    return true;
  }

  // Um item de lote. Sem token responde 428 com um lote de um item só (a janela confirma ali mesmo).
  // p: { operacao, id_condominio, cabecalho, item, resumo }.
  async function autorizarItem(req, res, p) {
    const prep = await preparar(req, res, p);
    if (!prep) return false;
    if (prep.livre) return autorizacao(req, p, prep, false);
    const chave = chaveItem(p.operacao, prep.alvo, p.cabecalho, p.item);
    const umItem = { hash: hashDe({ operacao: p.operacao, alvo: prep.alvo, cabecalho: p.cabecalho, itens: [p.item] }), itens: new Map([[chave, false]]), confirmado: false };
    const c = req.body && req.body.confirmacao_gravacao;
    let r = conferirToken(req, prep, p.operacao, c);
    if (r.motivo === 'sem_token') return pedirConfirmacao(req, res, p, prep, umItem);
    // Token de um pedido só (não de lote) usado aqui: tratado como de outra operação.
    if (!r.motivo && !r.rec.itens) r = { motivo: 'token_de_outra_operacao', suspeito: true, rec: r.rec, chave: r.chave };
    if (r.motivo) {
      const fim = await recusarToken(req, res, p, prep, r);
      if (fim === false) return false;
      return pedirConfirmacao(req, res, p, prep, umItem, r.motivo === 'token_invalido' ? 'token_vencido' : r.motivo);
    }
    if (!r.rec.confirmado) {
      // Token de um item só, emitido por esta rota: o reenvio com ele é a confirmação.
      if (r.rec.hash !== umItem.hash) {
        await recusarToken(req, res, p, prep, { motivo: 'conteudo_alterado', rec: r.rec, chave: r.chave });
        return pedirConfirmacao(req, res, p, prep, umItem, 'conteudo_alterado');
      }
      if (!nomeConfere(r.rec, c.nome_digitado)) {
        tokens.delete(r.chave);
        return pedirConfirmacao(req, res, p, prep, umItem, 'nome_nao_confere');
      }
      r.rec.confirmado = true;
    }
    if (!r.rec.itens.has(chave)) {
      auditar(req, 'gravacao_recusada', { operacao: p.operacao, id_superlogica: prep.ids[0], condominios: prep.ids, motivo: 'item_fora_do_lote', resumo: resumoCurto(typeof p.resumo === 'object' ? p.resumo : null), confirmada: false }, true, 'item_fora_do_lote');
      res.status(409).json({ erro: 'item_fora_do_lote', detalhe: 'Esta leitura não estava na lista confirmada (ou mudou). Nada foi gravado. Confirme de novo.' });
      return false;
    }
    if (r.rec.itens.get(chave) === true) {
      auditar(req, 'gravacao_recusada', { operacao: p.operacao, id_superlogica: prep.ids[0], condominios: prep.ids, motivo: 'token_usado', confirmada: false }, false, 'token_usado');
      res.status(409).json({ erro: 'confirmacao_ja_usada', detalhe: 'Esta leitura já foi gravada com esta confirmação. Nada foi gravado agora.' });
      return false;
    }
    r.rec.itens.set(chave, true);
    if ([...r.rec.itens.values()].every(Boolean)) r.rec.usado = true;
    return autorizacao(req, p, prep, true);
  }

  // Prévia de uma cota (ponte): a tela diz quantos envios vai fazer e em quais caminhos. Sem token,
  // 428 com o resumo; com o token confirmado, 200 { confirmado, confirmacao }. No teste: 200 { livre }.
  // p: { operacao, id_condominio, quantidade, caminhos, resumo }. Mais de 1 envio: reforçada.
  async function previaCota(req, res, p) {
    const quantidade = Number(p.quantidade);
    const caminhos = [...new Set((p.caminhos || []).map(String))].sort();
    const q = Object.assign({}, p, { quantidade, sensivel: quantidade > 1 });
    const prep = await preparar(req, res, q);
    if (!prep) return false;
    if (prep.livre) { res.json({ livre: true }); return true; }
    const hash = hashDe({ operacao: p.operacao, alvo: prep.alvo, quantidade, caminhos });
    const registro = { hash, cota: { restante: quantidade, caminhos }, confirmado: false };
    const c = req.body && req.body.confirmacao_gravacao;
    const r = conferirToken(req, prep, p.operacao, c);
    if (r.motivo === 'sem_token') return pedirConfirmacao(req, res, q, prep, registro);
    if (r.motivo) {
      const fim = await recusarToken(req, res, q, prep, r);
      if (fim === false) return false;
      return pedirConfirmacao(req, res, q, prep, registro, r.motivo === 'token_invalido' ? 'token_vencido' : r.motivo);
    }
    if (!r.rec.cota || r.rec.hash !== hash || r.rec.confirmado) {
      await recusarToken(req, res, q, prep, { motivo: 'conteudo_alterado', rec: r.rec, chave: r.chave });
      return pedirConfirmacao(req, res, q, prep, registro, 'conteudo_alterado');
    }
    if (!nomeConfere(r.rec, c.nome_digitado)) {
      tokens.delete(r.chave);
      auditar(req, 'gravacao_recusada', { operacao: p.operacao, id_superlogica: prep.ids[0], condominios: prep.ids, motivo: 'nome_nao_confere', confirmada: false }, false, 'nome_nao_confere');
      return pedirConfirmacao(req, res, q, prep, registro, 'nome_nao_confere');
    }
    r.rec.confirmado = true;
    auditar(req, 'gravacao_lote_confirmado', { operacao: p.operacao, id_superlogica: prep.ids[0], condominios: prep.ids, quantidade, caminhos, resumo: r.rec.resumo, confirmada: true });
    res.json({ confirmado: true, confirmacao: { token: r.chave, id_condominio: prep.alvo, expira_em: new Date(r.rec.expira).toISOString() } });
    return true;
  }

  // Um envio da cota. O token vem à parte (cabeçalho da ponte). Sem token válido: 428 sem token novo
  // (a tela confirma a importação inteira antes). A cada envio a validade volta a 10 minutos (uma
  // importação grande não vence no meio enquanto está andando; parada por 10 minutos, vence).
  async function autorizarCota(req, res, p) {
    const prep = await preparar(req, res, p);
    if (!prep) return false;
    if (prep.livre) return autorizacao(req, p, prep, false);
    const recusa = (status, erro, motivo, detalhe, suspeito) => {
      auditar(req, 'gravacao_recusada', { operacao: p.operacao, id_superlogica: prep.ids[0], condominios: prep.ids, motivo, caminho: p.caminho || null, confirmada: false }, !!suspeito, motivo);
      res.status(status).json({ erro, motivo, detalhe });
      return false;
    };
    const r = conferirToken(req, prep, p.operacao, { token: typeof p.token === 'string' ? p.token.trim() : '', id_condominio: prep.alvo });
    const precisa = 'Gravação fora do condomínio de teste: confirme a importação na tela antes de enviar. Nada foi gravado.';
    if (r.motivo === 'sem_token' || r.motivo === 'token_invalido') return recusa(428, 'confirmacao_necessaria', r.motivo, precisa, false);
    if (r.motivo === 'token_vencido') { tokens.delete(r.chave); return recusa(428, 'confirmacao_necessaria', 'token_vencido', 'A confirmação da importação venceu. Confirme de novo para continuar. Nada foi gravado.', false); }
    if (r.motivo === 'token_usado') return recusa(409, 'confirmacao_ja_usada', 'token_usado', 'Os envios confirmados acabaram. Confirme de novo para continuar. Nada foi gravado.', false);
    if (r.motivo) { tokens.delete(r.chave); return recusa(403, 'confirmacao_invalida', r.motivo, 'Essa confirmação não vale para este envio. Nada foi gravado.', true); }
    if (!r.rec.cota || !r.rec.confirmado) return recusa(428, 'confirmacao_necessaria', 'nao_confirmado', precisa, !r.rec.cota);
    if (!r.rec.cota.caminhos.includes(String(p.caminho || ''))) return recusa(409, 'caminho_fora_da_confirmacao', 'caminho_fora_da_confirmacao', 'Este envio não faz parte da importação confirmada. Nada foi gravado.', true);
    if (r.rec.cota.restante <= 0) { r.rec.usado = true; return recusa(409, 'confirmacao_ja_usada', 'token_usado', 'Os envios confirmados acabaram. Confirme de novo para continuar. Nada foi gravado.', false); }
    r.rec.cota.restante--;
    r.rec.expira = agora() + VALIDADE_MS;
    if (r.rec.cota.restante === 0) r.rec.usado = true;
    return autorizacao(req, p, prep, true);
  }

  // Escrita pela ponte genérica (POST, PUT, DELETE em /api/superlogica/v2/condor/...). O condomínio
  // sai do ID_CONDOMINIO_COND/idCondominio da query ou do corpo (formulário); sem um condomínio só,
  // recusa. Devolve a autorização (quem chama registra o resultado com concluir) ou false (já respondeu).
  async function autorizarPonte(req, res, { url, corpo, token }) {
    const C = require('../superlogica/carteira');
    const rota = C.rotaDoProxy(url);
    let pares = [];
    try { pares = Array.from(new URL(String(url || ''), 'http://x').searchParams.entries()); } catch (e) { pares = []; }
    if (corpo && corpo.length) pares = pares.concat(C.camposDoCorpo(corpo, 'application/x-www-form-urlencoded'));
    const achou = C.idsCondominio(rota, pares);
    const ids = [...new Set(achou.explicitos.map(String))];
    if (!rota || achou.invalidos.length || achou.todos || ids.length !== 1) {
      const motivo = !rota ? 'caminho_nao_aceito' : 'sem_condominio';
      auditar(req, 'gravacao_recusada', { operacao: 'ponte_superlogica', id_superlogica: ids.length === 1 ? ids[0] : null, condominios: ids, motivo, caminho: rota, metodo: req.method, confirmada: false }, true, motivo);
      res.status(400).json({ erro: motivo, detalhe: !rota ? 'Endereço do Superlógica não aceito para gravação. Nada foi gravado.' : 'A gravação direta no Superlógica precisa indicar um condomínio só (ID_CONDOMINIO_COND). Nada foi gravado.' });
      return false;
    }
    if (bloqueada(req, res, 'ponte_superlogica', ids[0])) return false;
    return autorizarCota(req, res, { operacao: 'ponte_superlogica', id_condominio: ids[0], caminho: rota, token,
      resumo: { linhas: [{ rotulo: 'Envio', valor: req.method + ' ' + rota }] } });
  }

  // Para a tela e para quem precisa saber o estado sem gravar.
  function estado(operacao, idCondominio, extra) { return situacao(operacao, idCondominio, extra, lerEnv()); }
  function configuracao() {
    const env = lerEnv();
    const comLegado = Object.keys(OPERACOES).filter((k) => legados(k, env).size > 0);
    return { modo: modo(env), teste: [...condominiosTeste(env)], legados: comLegado };
  }

  const api = { autorizar, previaLote, autorizarItem, previaCota, autorizarCota, autorizarPonte, bloqueada, estado, configuracao };
  // O mapa dos tokens só aparece nos testes (NODE_ENV=test), nunca no servidor.
  if (process.env.NODE_ENV === 'test') Object.defineProperty(api, '_tokens', { value: tokens, enumerable: false });
  return api;
}

module.exports = { criarPoliticaEscrita, situacao, modo, condominiosTeste, legados, nomeCurto, normalizar, canonico, hashDe, OPERACOES, CAMINHOS_PONTE, NUNCA, VALIDADE_MS, LIMITE_LOTE };
