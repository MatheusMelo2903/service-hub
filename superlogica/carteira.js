// Carteira com bloqueio de verdade e módulos das abas novas (T18).
//
// Carteira (T09): profiles.carteiras guarda ids de grupos do Superlógica (Carteira A, B...).
// Até a T18 era só filtro de tela; agora o servidor recusa (403) qualquer chamada a um
// condomínio fora da carteira de quem chama. Vê todos: GESTOR, acesso interno, quem não tem
// carteira e quem tem a ação configuracoes.todas_carteiras ("ver todas as carteiras", ação
// normal que o GESTOR pode dar). Carteira apagada no Superlógica: não vê nenhum (fechado).
// Falha ao conferir a carteira de quem tem carteira: recusa (503), nunca libera.
//
// Onde vale (montado no server.js antes das rotas):
//  1. guardaRotas: rotas com o condomínio no caminho (/api/condominio/:id/..., /api/cobranca/
//     condominio/:id..., /api/comparativo/condominio/:id...) e rotas com id_superlogica no corpo
//     JSON (ata, prestação pelo Superlógica, conferência de despesas, comunicado, multa). O corpo
//     é lido aqui com o mesmo limite da rota; o express.json da rota vê que já foi lido e não lê
//     de novo. Também confere os módulos ficha_condominio, cobranca e comparativo.
//  2. guardaProxy: /api/superlogica (proxy da API condor). Só age para quem tem carteira: o
//     condomínio vem da query (idCondominio, ID_CONDOMINIO_COND, id em condominios/...) ou do
//     corpo do POST/PUT; condomínio fora recusa; gravação sem condomínio recusa; a resposta JSON
//     perde os itens de condomínios fora da carteira (listas gerais com id=-1); resposta que não
//     é JSON só passa quando a chamada citou um condomínio da carteira.

const { condominiosDasCarteiras } = require('./carteiras');

const ACAO_TODAS = 'todas_carteiras';
const TTL_MS = 60 * 1000;
const MAX_CORPO_PROXY = 5 * 1024 * 1024;

// Ação dentro de um módulo visível (mesma regra do temVerChaves da T15).
function temAcao(perfil, modulo, acao) {
  const m = perfil && perfil.permissoes && perfil.permissoes[modulo];
  return !!(m && m.visivel === true && Array.isArray(m.acoes) && m.acoes.includes(acao));
}
// Módulo das abas novas: GESTOR sempre; os outros precisam do módulo visível (e da ação, se pedida).
function temModulo(perfil, modulo, acao) {
  if (!perfil) return false;
  if (perfil.role === 'GESTOR') return true;
  const m = perfil.permissoes && perfil.permissoes[modulo];
  if (!m || m.visivel !== true) return false;
  return !acao || (Array.isArray(m.acoes) && m.acoes.includes(acao));
}

// Regras de rota (caminho relativo a /api). A primeira que casa vale.
//  modulo/acao: módulo exigido; corpo: campo do condomínio no corpo JSON e limite do parser;
//  semCondominio: rota sem condomínio (só o módulo); filtrarResposta: tira da resposta os
//  itens de condomínios fora da carteira.
const REGRAS = [
  { re: /^\/condominio\/([^/]+)\/(ficha|auditoria|relatorio-mensal)\/?$/, modulo: 'ficha_condominio' },
  { re: /^\/condominio\/([^/]+)(\/|$)/ },
  { re: /^\/cobranca\/condominio\/([^/]+)\/segunda-via\/?$/, modulo: 'cobranca', acao: 'segunda_via' },
  { re: /^\/cobranca\/condominio\/([^/]+)(\/|$)/, modulo: 'cobranca' },
  { re: /^\/comparativo\/condominio\/([^/]+)(\/|$)/, modulo: 'comparativo' },
  { re: /^\/unidades\/busca\/?$/, modulo: 'ficha_condominio', semCondominio: true, filtrarResposta: true },
  { re: /^\/atas\/gerar\/?$/, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '36mb' } },
  { re: /^\/prestacao\/v13\/superlogica\/?$/, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '20kb' } },
  { re: /^\/despesas\/verificar\/?$/, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '1mb' } },
  { re: /^\/comunicados\/publicar\/?$/, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '100kb' } },
  { re: /^\/multas\/registrar\/?$/, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '100kb' } },
];
function regraDa(metodo, caminho) {
  for (const r of REGRAS) {
    if (r.metodo && r.metodo !== metodo) continue;
    const m = caminho.match(r.re);
    if (m) return { regra: r, id: r.semCondominio || r.corpo ? null : m[1] };
  }
  return null;
}
const idValido = (v) => /^[1-9][0-9]{0,8}$/.test(String(v == null ? '' : v));

// Condomínios citados numa chamada ao proxy. Nomes de campo sem diferença de maiúscula,
// inclusive dentro de colchetes (COBRANCAS[0][ID_CONDOMINIO_COND]). Em condominios/... o
// parâmetro "id" é o código do condomínio. Valor -1 ou 0 = todos (não é um condomínio).
const RE_CAMPO_COND = /(^|\[)(idcondominio|id_condominio_cond|id_condominio|condominioatual)\]?$/i;
function idsCondominio(rota, pares) {
  const ehCondominios = /^condominios(\/|$)/i.test(rota);
  const out = { explicitos: [], todos: false };
  for (const [k, v] of pares) {
    const chave = String(k || '');
    if (!(RE_CAMPO_COND.test(chave) || (ehCondominios && /^id$/i.test(chave)))) continue;
    String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => {
      const n = Number(x);
      if (Number.isInteger(n) && n > 0) out.explicitos.push(n);
      else out.todos = true;
    });
  }
  return out;
}

// Campos do corpo de um POST/PUT do proxy (formulário, JSON ou multipart).
function camposDoCorpo(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const txt = buf.toString(ct.includes('multipart') ? 'latin1' : 'utf8');
  if (ct.includes('json')) {
    const pares = [];
    try {
      (function andar(v, prefixo) {
        if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => andar(x, prefixo ? prefixo + '[' + k + ']' : k));
        else pares.push([prefixo, v]);
      })(JSON.parse(txt), '');
    } catch (e) { /* corpo inválido: o Superlógica recusa; aqui fica sem condomínio */ }
    return pares;
  }
  if (ct.includes('multipart')) {
    const pares = [];
    const re = /name="([^"]+)"\r\n(?:[^\r\n]+\r\n)*\r\n([^\r]*)/g;
    let m;
    while ((m = re.exec(txt))) pares.push([m[1], m[2]]);
    return pares;
  }
  return Array.from(new URLSearchParams(txt).entries());
}

// Tira de uma resposta JSON os objetos de condomínios fora da carteira.
const CAMPOS_COND_RESPOSTA = ['id_condominio_cond', 'ID_CONDOMINIO_COND', 'id_condominio', 'idCondominio', 'id_superlogica'];
function condDoObjeto(o) {
  for (const k of CAMPOS_COND_RESPOSTA) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') {
      const n = Number(o[k]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}
function filtrarJson(v, ids) {
  let removidos = 0;
  const fora = (o) => { const c = condDoObjeto(o); return c !== null && c > 0 && !ids.has(c); };
  function andar(x, prof) {
    if (prof > 20 || x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) {
      return x.filter((i) => {
        if (i && typeof i === 'object' && !Array.isArray(i) && fora(i)) { removidos++; return false; }
        return true;
      }).map((i) => andar(i, prof + 1));
    }
    const o = {};
    for (const [k, i] of Object.entries(x)) {
      if (i && typeof i === 'object' && !Array.isArray(i) && fora(i)) { removidos++; o[k] = null; }
      else o[k] = andar(i, prof + 1);
    }
    return o;
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && fora(v)) return { bloqueado: true, removidos: 1 };
  const valor = andar(v, 0);
  // Listas do Hub com contador (busca de unidades): o contador acompanha o que sobrou.
  if (valor && !Array.isArray(valor) && Array.isArray(valor.itens) && typeof valor.quantidade === 'number' && removidos) {
    valor.quantidade = valor.itens.length;
    valor.foraCarteira = removidos;
  }
  return { valor, removidos };
}

// Lê o corpo inteiro (com teto) e devolve um Buffer.
function lerCorpo(req, max) {
  return new Promise((ok, falha) => {
    const partes = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > max) { falha(Object.assign(new Error('corpo_grande'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', falha);
  });
}

// Segura a resposta inteira para filtrar antes de mandar (as rotas escrevem com write/end).
function interceptarResposta(res, aoTerminar) {
  const write0 = res.write.bind(res);
  const end0 = res.end.bind(res);
  const partes = [];
  const pegar = (c, enc) => { if (c != null && typeof c !== 'function') partes.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === 'string' ? enc : 'utf8')); };
  res.write = (c, enc, cb) => { pegar(c, enc); const f = typeof enc === 'function' ? enc : cb; if (typeof f === 'function') f(); return true; };
  res.end = (c, enc, cb) => {
    pegar(c, enc);
    res.write = write0;
    res.end = end0;
    const enviar = (corpo) => {
      if (!res.headersSent) { res.removeHeader('ETag'); res.setHeader('Content-Length', Buffer.byteLength(corpo)); }
      return end0(corpo);
    };
    try { aoTerminar(Buffer.concat(partes), enviar); } catch (e) {
      if (!res.headersSent) { res.statusCode = 502; res.setHeader('Content-Type', 'application/json; charset=utf-8'); }
      enviar(JSON.stringify({ erro: 'falha_carteira' }));
    }
    const f = typeof enc === 'function' ? enc : (typeof c === 'function' ? c : cb);
    if (typeof f === 'function') f();
    return res;
  };
}
function negar(res, status, erro, detalhe) {
  res.status(status).json({ erro, detalhe });
}

function criarCarteira({ lerPerfil, lerCarteirasPerfis, semColuna, gruposCarteiras, ativo, express }) {
  const cache = new Map(); // userId -> { ate, v }

  async function calcular(userId) {
    const perfil = await lerPerfil(userId);
    if (!perfil) throw new Error('perfil_indisponivel');
    if (perfil.role === 'GESTOR') return { todas: true, motivo: 'gestor', perfil };
    if (temAcao(perfil, 'configuracoes', ACAO_TODAS)) return { todas: true, motivo: 'todas_carteiras', perfil };
    const mapa = await lerCarteirasPerfis(perfil.id);
    if (!mapa) {
      // Banco sem a coluna (migration 008 não aplicada): ninguém tem carteira ainda.
      if (semColuna()) return { todas: true, motivo: 'sem_coluna', perfil };
      throw new Error('carteira_indisponivel');
    }
    const minhas = mapa[perfil.id] || [];
    if (!minhas.length) return { todas: true, motivo: 'sem_carteira', perfil };
    const r = condominiosDasCarteiras(await gruposCarteiras(), minhas);
    return {
      todas: false, perfil, carteiras: r.carteiras, ids_superlogica: r.ids_superlogica, ids: new Set(r.ids_superlogica),
      aviso: r.carteiras.length ? '' : 'Sua carteira não existe mais no Superlógica. Fale com o gestor.',
    };
  }

  // { todas: true } ou { todas: false, ids: Set, ids_superlogica, carteiras }. Lança erro quando
  // não deu para conferir (quem chama recusa).
  async function escopo(req) {
    if (req.authMode === 'internal') return { todas: true, motivo: 'interno' };
    if (!ativo()) return { todas: true, motivo: 'nao_configurado' };
    const uid = req.user && req.user.sub;
    if (!uid) throw new Error('sem_usuario');
    const c = cache.get(uid);
    if (c && c.ate > Date.now()) return c.v;
    const v = await calcular(uid);
    cache.set(uid, { ate: Date.now() + TTL_MS, v });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return v;
  }
  function esquecer(uid) { if (uid) cache.delete(String(uid).toLowerCase()); cache.delete(uid); }
  function esquecerTudo() { cache.clear(); }
  const dentro = (esc, id) => esc.todas || esc.ids.has(Number(id));

  // Para as rotas que ainda chamam direto (cobrança, comparativo): true/false, sem responder.
  async function dentroDaCarteira(req, id) {
    try { return dentro(await escopo(req), id); } catch (e) { return false; }
  }
  // Responde 403/503 e devolve false quando não pode.
  async function exigir(req, res, id) {
    let esc;
    try { esc = await escopo(req); } catch (e) {
      negar(res, 503, 'carteira_indisponivel', 'Não foi possível conferir sua carteira agora. Tente de novo em instantes.');
      return false;
    }
    if (dentro(esc, id)) return true;
    negar(res, 403, 'fora_da_carteira', 'Esse condomínio não está na sua carteira.');
    return false;
  }

  // 1. Rotas do Hub com condomínio no caminho ou no corpo, e módulos das abas.
  function guardaRotas(requireAuth) {
    const parsers = new Map();
    const parserDe = (limite) => { if (!parsers.has(limite)) parsers.set(limite, express.json({ limit: limite })); return parsers.get(limite); };
    return function (req, res, next) {
      const achou = regraDa(req.method, req.path);
      if (!achou) return next();
      const { regra } = achou;
      if (!regra.corpo && !regra.semCondominio && !idValido(achou.id)) return next(); // a rota responde 400
      requireAuth(req, res, () => {
        const conferir = async () => {
          let id = achou.id;
          if (regra.corpo) {
            const b = req.body || {};
            id = b[regra.corpo.campo] != null && b[regra.corpo.campo] !== '' ? String(b[regra.corpo.campo]) : null;
            if (!id || !idValido(id)) return next(); // sem condomínio (ata sem código) ou inválido: a rota decide
          }
          let esc;
          try { esc = await escopo(req); } catch (e) {
            return negar(res, 503, 'carteira_indisponivel', 'Não foi possível conferir suas permissões agora. Tente de novo em instantes.');
          }
          if (regra.modulo && req.authMode !== 'internal' && !temModulo(esc.perfil, regra.modulo, regra.acao)) {
            return negar(res, 403, 'modulo_sem_acesso', regra.acao === 'segunda_via' ? 'Seu usuário não pode gerar a 2ª via.' : 'Seu usuário não tem acesso a esta aba.');
          }
          if (id && !dentro(esc, id)) return negar(res, 403, 'fora_da_carteira', 'Esse condomínio não está na sua carteira.');
          if (regra.filtrarResposta && !esc.todas) {
            interceptarResposta(res, (buf, enviar) => {
              const txt = buf.toString('utf8');
              let j;
              try { j = JSON.parse(txt); } catch (e) { return enviar(buf); }
              const f = filtrarJson(j, esc.ids);
              enviar(JSON.stringify(f.bloqueado ? { erro: 'fora_da_carteira' } : f.valor));
            });
          }
          next();
        };
        if (regra.corpo) parserDe(regra.corpo.limite)(req, res, (err) => (err ? next(err) : conferir()));
        else conferir();
      });
    };
  }

  // 2. Proxy /api/superlogica (montar com requireAuth antes do proxy).
  async function guardaProxy(req, res, next) {
    let esc;
    try { esc = await escopo(req); } catch (e) {
      return negar(res, 503, 'carteira_indisponivel', 'Não foi possível conferir sua carteira agora. Tente de novo em instantes.');
    }
    if (esc.todas) return next();
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { return next(); } // o proxy recusa o caminho
    const rota = u.pathname.replace(/^\/v2\/condor\//i, '').replace(/\/+$/, '');
    const achados = idsCondominio(rota, Array.from(u.searchParams.entries()));
    const escrita = req.method === 'POST' || req.method === 'PUT';
    if (escrita) {
      let buf;
      try { buf = await lerCorpo(req, MAX_CORPO_PROXY); } catch (e) {
        return negar(res, e.status === 413 ? 413 : 400, e.status === 413 ? 'corpo_grande' : 'corpo_invalido', 'Não foi possível ler o envio.');
      }
      const doCorpo = idsCondominio(rota, camposDoCorpo(buf, req.headers['content-type']));
      achados.explicitos.push(...doCorpo.explicitos);
      achados.todos = achados.todos || doCorpo.todos;
      // O proxy repassa o corpo com req.pipe: entrega o que já foi lido.
      req.pipe = (destino) => { destino.end(buf); return destino; };
    }
    if (achados.explicitos.some((id) => !esc.ids.has(id))) return negar(res, 403, 'fora_da_carteira', 'Esse condomínio não está na sua carteira.');
    if ((escrita || req.method === 'DELETE') && !achados.explicitos.length) {
      return negar(res, 403, 'sem_condominio', 'Com carteira definida, gravações no Superlógica precisam indicar o condomínio.');
    }
    const citouCondominio = achados.explicitos.length > 0;
    interceptarResposta(res, (buf, enviar) => {
      if (res.statusCode >= 400) return enviar(buf); // erro do proxy ou do Superlógica: segue igual
      const txt = buf.toString('utf8').replace(/^﻿/, '');
      let j;
      if (/^\s*[{\[]/.test(txt)) { try { j = JSON.parse(txt); } catch (e) { j = undefined; } }
      if (j === undefined) {
        if (citouCondominio) return enviar(buf); // PDF, imagem ou texto de um condomínio da carteira
        res.statusCode = 403;
        res.removeHeader('Content-Disposition');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return enviar(JSON.stringify({ erro: 'fora_da_carteira', detalhe: 'Esse arquivo não pode ser conferido com a sua carteira.' }));
      }
      const f = filtrarJson(j, esc.ids);
      if (f.bloqueado) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return enviar(JSON.stringify({ erro: 'fora_da_carteira', detalhe: 'Esse condomínio não está na sua carteira.' }));
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      enviar(JSON.stringify(f.valor));
    });
    next();
  }

  return { escopo, esquecer, esquecerTudo, dentroDaCarteira, exigir, guardaRotas, guardaProxy, dentro };
}

module.exports = { criarCarteira, temAcao, temModulo, regraDa, idsCondominio, camposDoCorpo, filtrarJson, ACAO_TODAS, REGRAS };
