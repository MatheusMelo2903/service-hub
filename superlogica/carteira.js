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
//     O caminho é comparado sem diferença de maiúscula e já decodificado (%31 = 1), como o
//     Express casa as rotas. Defesa em profundidade no server.js: app.param('idSuperlogica')
//     confere a carteira de novo, e as rotas de corpo chamam exigir() depois de validar o id.
//  2. guardaProxy: /api/superlogica (proxy da API condor). Só age para quem tem carteira:
//     . caminho só no formato modulo/acao (letras), sem barra dupla, ponto ou código;
//     . o condomínio vem da query ou do corpo, com os nomes lidos como o PHP lê (ponto, espaço e
//       colchete aberto sem fechar viram sublinhado; sem diferença de maiúscula); qualquer campo
//       cujo nome cite "condominio" precisa de inteiro puro da carteira; lista ou array recusa;
//     . corpo só application/x-www-form-urlencoded (JSON e multipart: 415);
//     . gravação sem condomínio ou com "todos" (-1, 0) recusa;
//     . leitura sem condomínio da carteira só em condominios/get e condominios/index, e a
//       resposta só leva itens que trazem o condomínio e estão na carteira (falha fechada);
//     . a resposta JSON perde os itens de condomínios fora da carteira, inteiros (sem deixar os
//       campos irmãos); resposta que não é JSON só passa quando a chamada citou um condomínio
//       da carteira.

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

// Regras de rota (caminho relativo a /api, já decodificado). A primeira que casa vale.
//  modulo/acao: módulo exigido; corpo: campo do condomínio no corpo JSON e limite do parser;
//  semCondominio: rota sem condomínio (só o módulo); filtrarResposta: tira da resposta os
//  itens de condomínios fora da carteira. Todas sem diferença de maiúscula (flag i), como o Express.
const REGRAS = [
  { re: /^\/condominio\/([^/]+)\/(ficha|auditoria|relatorio-mensal)\/?$/i, modulo: 'ficha_condominio' },
  { re: /^\/condominio\/([^/]+)(\/|$)/i },
  { re: /^\/cobranca\/condominio\/([^/]+)\/segunda-via\/?$/i, modulo: 'cobranca', acao: 'segunda_via' },
  { re: /^\/cobranca\/condominio\/([^/]+)(\/|$)/i, modulo: 'cobranca' },
  { re: /^\/comparativo\/condominio\/([^/]+)(\/|$)/i, modulo: 'comparativo' },
  { re: /^\/unidades\/busca\/?$/i, modulo: 'ficha_condominio', semCondominio: true, filtrarResposta: true },
  { re: /^\/atas\/gerar\/?$/i, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '36mb' } },
  { re: /^\/prestacao\/v13\/superlogica\/?$/i, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '20kb' } },
  { re: /^\/despesas\/verificar\/?$/i, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '1mb' } },
  { re: /^\/comunicados\/publicar\/?$/i, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '100kb' } },
  { re: /^\/multas\/registrar\/?$/i, metodo: 'POST', corpo: { campo: 'id_superlogica', limite: '100kb' } },
];
// Caminho decodificado pedaço a pedaço. null = codificação inválida ou pedaço com barra
// codificada (%2F), que não é caminho de rota nenhuma (quem chama responde 400).
function caminhoDecodificado(p) {
  const pedacos = String(p || '').split('/');
  const out = [];
  for (const x of pedacos) {
    let d;
    try { d = decodeURIComponent(x); } catch (e) { return null; }
    if (d.includes('/') || d.includes('\\') || d.includes('\0')) return null;
    out.push(d);
  }
  return out.join('/');
}
function regraDa(metodo, caminho) {
  const met = String(metodo || '').toUpperCase();
  for (const r of REGRAS) {
    if (r.metodo && r.metodo !== met) continue;
    const m = caminho.match(r.re);
    if (m) return { regra: r, id: r.semCondominio || r.corpo ? null : m[1] };
  }
  return null;
}
const idValido = (v) => /^[1-9][0-9]{0,8}$/.test(String(v == null ? '' : v));
// Valor de id vindo de corpo JSON: só texto ou número, e inteiro positivo puro.
const idDoCorpoValido = (v) => (typeof v === 'string' || typeof v === 'number') && idValido(v);

// Nome de parâmetro lido como o PHP do Superlógica lê: corta no byte nulo, tira espaços do
// começo, ponto e espaço do nome base viram sublinhado; "[" sem "]" depois vira sublinhado;
// com colchetes fechados, o nome base vem antes do primeiro "[" e cada [x] é um pedaço.
// Devolve os pedaços em minúsculas: ['contatos', '0', 'id_condominio_cond'].
function partesPhp(nome) {
  let s = String(nome == null ? '' : nome);
  const nul = s.indexOf('\0');
  if (nul >= 0) s = s.slice(0, nul);
  s = s.replace(/^[ \t\r\n\v\f]+/, '');
  const ab = s.indexOf('[');
  let base = s;
  let resto = '';
  if (ab >= 0 && s.indexOf(']', ab) >= 0) { base = s.slice(0, ab); resto = s.slice(ab); }
  base = base.replace(/[ .[]/g, '_').toLowerCase();
  const partes = [base];
  let m;
  while ((m = resto.match(/^\[([^\]]*)\]/))) { partes.push(m[1].toLowerCase()); resto = resto.slice(m[0].length); }
  return partes;
}
// Pedaço de nome que cita condomínio (sem olhar sinais: id_condominio_cond, idCondominio,
// condominioatual, ID.CONDOMINIO.COND...). Na dúvida conta como condomínio (fechado).
const citaCondominio = (p) => String(p).replace(/[^a-z0-9]/g, '').includes('condominio');
// Bandeiras conhecidas do Superlógica (nome base já em minúsculas, como partesPhp devolve).
// Lista exata (C04, menor 1 da revisão dos menores da T18): um prefixo largo deixaria passar
// calada uma bandeira desconhecida que alargue o resultado. Nome fora da lista conta como código.
const BANDEIRAS = new Set(['somentecondominiosativos', 'exibircondominiosinativos']);
const BANDEIRA = { test: (nome) => BANDEIRAS.has(String(nome).replace(/[^a-z0-9]/g, '')) };

// Condomínios citados numa chamada ao proxy.
//  explicitos: ids inteiros puros; todos: -1 ou 0 (lista geral); invalidos: nomes ou valores
//  que não dá para conferir (lista, array, "136abc", " 136", "0x88"), que recusam com 400.
// Em condominios/... o parâmetro "id" é o código do condomínio.
function idsCondominio(rota, pares) {
  const ehCondominios = /^condominios(\/|$)/i.test(String(rota || ''));
  const out = { explicitos: [], todos: false, invalidos: [] };
  for (const [k, v] of pares) {
    const partes = partesPhp(k);
    const idxCond = [];
    partes.forEach((p, i) => { if (citaCondominio(p)) idxCond.push(i); });
    if (ehCondominios && partes[0] === 'id') idxCond.push(0);
    if (!idxCond.length) continue;
    const ultimo = partes.length - 1;
    // Bandeira (somenteCondominiosAtivos, exibirCondominiosInativos...): nome simples, sem
    // colchetes, cujo nome base está na lista exata BANDEIRAS (C04).
    // Com valor exatamente "0" ou "1" não é código de condomínio; qualquer outro valor recusa.
    if (ultimo === 0 && BANDEIRA.test(partes[0])) {
      const vb = typeof v === 'string' ? v : String(v == null ? '' : v);
      if (vb === '0' || vb === '1') continue;
      out.invalidos.push(String(k));
      continue;
    }
    // condomínio com [] ou [0] depois (lista de condomínios) ou mais de um pedaço citando: recusa
    if (idxCond.some((i) => i !== ultimo) || idxCond.length > 1) { out.invalidos.push(String(k)); continue; }
    const valor = typeof v === 'string' ? v : String(v == null ? '' : v);
    if (idValido(valor)) out.explicitos.push(Number(valor));
    else if (valor === '-1' || valor === '0') out.todos = true;
    else if (valor === '' && ultimo > 0) continue; // campo de condomínio vazio dentro de lista (contatos[0][ID_CONDOMINIO_COND]=)
    else out.invalidos.push(String(k));
  }
  return out;
}

// Campos de um corpo application/x-www-form-urlencoded (o único que o proxy aceita de quem
// tem carteira). JSON e multipart ficam aqui só para os testes antigos e para a sonda.
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
    } catch (e) { /* corpo inválido */ }
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
// Tipo do corpo exato, antes do ";" (application/x-www-form-urlencoded; charset=UTF-8 passa;
// "application/x-www-form-urlencoded; x=json" também é formulário e é lido como formulário).
const ehFormulario = (ct) => String(ct || '').split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';

// Caminho do proxy para quem tem carteira: /v2/condor/modulo ou /v2/condor/modulo/acao, só
// letras, uma barra final opcional. Devolve a rota em minúsculas ou null.
function rotaDoProxy(url) {
  const caminho = String(url || '').split('?')[0];
  const m = caminho.match(/^\/v2\/condor\/([a-z]+(?:\/[a-z]+)?)\/?$/i);
  return m ? m[1].toLowerCase() : null;
}
// Leituras sem condomínio da carteira (lista geral) que quem tem carteira pode fazer: só
// estas, que trazem o código do condomínio em cada item.
const LEITURA_GERAL = new Set(['condominios', 'condominios/get', 'condominios/index']);

// Tira de uma resposta JSON os objetos de condomínios fora da carteira.
// Campo de condomínio sem diferença de maiúscula; valor que não é inteiro positivo conta como
// fora (fechado). Objeto que tem, em qualquer nível abaixo, um objeto de condomínio fora sai
// inteiro (não ficam os campos irmãos). Em modo estrito (lista geral), item de lista que não
// traz o próprio condomínio também sai.
const CAMPOS_COND_RESPOSTA = new Set(['id_condominio_cond', 'id_condominio', 'idcondominio', 'id_superlogica']);
const SAI = Symbol('sai');
// null = objeto sem campo de condomínio; true = todos os campos de condomínio estão na carteira; false = algum fora.
function condDoObjeto(o, ids) {
  let achou = false;
  for (const [k, v] of Object.entries(o)) {
    if (!CAMPOS_COND_RESPOSTA.has(k.toLowerCase())) continue;
    if (v === undefined || v === null || v === '') continue;
    if (v && typeof v === 'object') return false;
    achou = true;
    if (!idValido(typeof v === 'number' ? String(v) : String(v).trim()) || !ids.has(Number(String(v).trim()))) return false;
  }
  return achou ? true : null;
}
function filtrarJson(v, ids, opcoes) {
  const estrito = !!(opcoes && opcoes.estrito);
  let removidos = 0;
  function andar(x, prof, itemDeLista) {
    if (x === null || typeof x !== 'object') return x;
    if (prof > 20) return SAI; // nada da API tem essa profundidade; na dúvida, não repassa
    if (Array.isArray(x)) {
      const out = [];
      for (const i of x) {
        const r = andar(i, prof + 1, true);
        if (r === SAI) removidos++;
        else out.push(r);
      }
      return out;
    }
    const c = condDoObjeto(x, ids);
    if (c === false) return SAI;
    if (c === null && estrito && itemDeLista) return SAI;
    const o = {};
    for (const [k, i] of Object.entries(x)) {
      const r = andar(i, prof + 1, false);
      if (r === SAI) return SAI; // filho de outro condomínio: o objeto todo sai
      o[k] = r;
    }
    return o;
  }
  const valor = andar(v, 0, false);
  if (valor === SAI) return { bloqueado: true, removidos: removidos + 1 };
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

// aoNegar(req, motivo, id): chamado em toda recusa 400, 403 ou 415 (fora_da_carteira, modulo_sem_acesso,
// sem_condominio, condominio_invalido, caminho_invalido, tipo_nao_aceito), para a auditoria da
// segurança registrar como suspeito. Erro dentro dele é ignorado.
function criarCarteira({ lerPerfil, lerCarteirasPerfis, semColuna, gruposCarteiras, ativo, express, aoNegar }) {
  const cache = new Map(); // userId -> { ate, v }
  let avisar = typeof aoNegar === 'function' ? aoNegar : null;
  function recusar(req, res, status, erro, detalhe, id) {
    if (avisar && status !== 503) { try { avisar(req, erro, id == null ? null : id); } catch (e) { /* auditoria não derruba a recusa */ } }
    negar(res, status, erro, detalhe);
  }

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
    const chave = String(uid).toLowerCase();
    const c = cache.get(chave);
    if (c && c.ate > Date.now()) return c.v;
    const v = await calcular(uid);
    cache.set(chave, { ate: Date.now() + TTL_MS, v });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return v;
  }
  // Chamar ao mudar carteira, permissões, cargo, bloqueio ou concede de um usuário.
  function esquecer(uid) { if (uid != null) cache.delete(String(uid).toLowerCase()); }
  function esquecerTudo() { cache.clear(); }
  // A segurança pode ligar a auditoria depois de criar a carteira.
  function definirAoNegar(f) { avisar = typeof f === 'function' ? f : null; }
  const dentro = (esc, id) => esc.todas || (idValido(id) && esc.ids.has(Number(id)));

  // Para as rotas que ainda chamam direto (cobrança, comparativo): true/false, sem responder.
  async function dentroDaCarteira(req, id) {
    try { return dentro(await escopo(req), id); } catch (e) { return false; }
  }
  // Responde 400/403/503 e devolve false quando não pode.
  async function exigir(req, res, id) {
    if (!idValido(id)) { negar(res, 400, 'id_invalido', 'Código do Superlógica inválido.'); return false; }
    let esc;
    try { esc = await escopo(req); } catch (e) {
      negar(res, 503, 'carteira_indisponivel', 'Não foi possível conferir sua carteira agora. Tente de novo em instantes.');
      return false;
    }
    if (dentro(esc, id)) return true;
    recusar(req, res, 403, 'fora_da_carteira', 'Esse condomínio não está na sua carteira.', id);
    return false;
  }

  // 1. Rotas do Hub com condomínio no caminho ou no corpo, e módulos das abas.
  function guardaRotas(requireAuth) {
    const parsers = new Map();
    const parserDe = (limite) => { if (!parsers.has(limite)) parsers.set(limite, express.json({ limit: limite })); return parsers.get(limite); };
    return function (req, res, next) {
      const caminho = caminhoDecodificado(req.path);
      if (caminho === null) return negar(res, 400, 'caminho_invalido', 'Endereço inválido.');
      const achou = regraDa(req.method, caminho);
      if (!achou) return next();
      const { regra } = achou;
      if (!regra.corpo && !regra.semCondominio && !idValido(achou.id)) return negar(res, 400, 'id_invalido', 'Código do Superlógica inválido.');
      requireAuth(req, res, () => {
        const conferir = async () => {
          let id = achou.id;
          if (regra.corpo) {
            const b = req.body && typeof req.body === 'object' ? req.body : {};
            const v = b[regra.corpo.campo];
            if (v === undefined || v === null || v === '') id = null; // sem condomínio (ata sem código): a rota decide
            else if (!idDoCorpoValido(v)) return negar(res, 400, 'id_invalido', 'Código do Superlógica inválido.');
            else id = String(v);
          }
          let esc;
          try { esc = await escopo(req); } catch (e) {
            return negar(res, 503, 'carteira_indisponivel', 'Não foi possível conferir suas permissões agora. Tente de novo em instantes.');
          }
          if (regra.modulo && req.authMode !== 'internal' && !temModulo(esc.perfil, regra.modulo, regra.acao)) {
            return recusar(req, res, 403, 'modulo_sem_acesso', regra.acao === 'segunda_via' ? 'Seu usuário não pode gerar a 2ª via.' : 'Seu usuário não tem acesso a esta aba.', id);
          }
          if (id && !dentro(esc, id)) return recusar(req, res, 403, 'fora_da_carteira', 'Esse condomínio não está na sua carteira.', id);
          if (regra.filtrarResposta && !esc.todas) {
            interceptarResposta(res, (buf, enviar) => {
              if (res.statusCode >= 400) return enviar(buf);
              let j;
              try { j = JSON.parse(buf.toString('utf8')); } catch (e) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return enviar(JSON.stringify({ erro: 'fora_da_carteira' }));
              }
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
    const rota = rotaDoProxy(req.url);
    if (!rota) return recusar(req, res, 400, 'caminho_invalido', 'Endereço do Superlógica não aceito para quem tem carteira.');
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { return negar(res, 400, 'caminho_invalido', 'Endereço inválido.'); }
    const achados = idsCondominio(rota, Array.from(u.searchParams.entries()));
    const leitura = req.method === 'GET' || req.method === 'HEAD';
    if (!leitura) {
      // Corpo: o proxy só repassa POST e PUT; DELETE e outros vão sem corpo, mas qualquer
      // corpo enviado é lido e conferido do mesmo jeito.
      const temCorpo = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) > 0 : req.headers['transfer-encoding'] !== undefined;
      if (temCorpo && !ehFormulario(req.headers['content-type'])) {
        return recusar(req, res, 415, 'tipo_nao_aceito', 'Envio ao Superlógica só como formulário.');
      }
      let buf;
      try { buf = await lerCorpo(req, MAX_CORPO_PROXY); } catch (e) {
        return negar(res, e.status === 413 ? 413 : 400, e.status === 413 ? 'corpo_grande' : 'corpo_invalido', 'Não foi possível ler o envio.');
      }
      if (buf.length && !ehFormulario(req.headers['content-type'])) {
        return recusar(req, res, 415, 'tipo_nao_aceito', 'Envio ao Superlógica só como formulário.');
      }
      const doCorpo = idsCondominio(rota, camposDoCorpo(buf, 'application/x-www-form-urlencoded'));
      achados.explicitos.push(...doCorpo.explicitos);
      achados.invalidos.push(...doCorpo.invalidos);
      achados.todos = achados.todos || doCorpo.todos;
      // O proxy repassa o corpo com req.pipe: entrega o que já foi lido.
      req.pipe = (destino) => { destino.end(buf); return destino; };
    }
    if (achados.invalidos.length) {
      return recusar(req, res, 400, 'condominio_invalido', 'O código do condomínio precisa ser um número só.');
    }
    const fora = achados.explicitos.find((id) => !esc.ids.has(id));
    if (fora !== undefined) return recusar(req, res, 403, 'fora_da_carteira', 'Esse condomínio não está na sua carteira.', fora);
    if (!leitura && (achados.todos || !achados.explicitos.length)) {
      return recusar(req, res, 403, 'sem_condominio', 'Com carteira definida, gravações no Superlógica precisam indicar um condomínio da carteira.');
    }
    const geral = achados.todos || !achados.explicitos.length;
    if (geral && !LEITURA_GERAL.has(rota)) {
      return recusar(req, res, 403, 'sem_condominio', 'Com carteira definida, a consulta precisa indicar um condomínio da carteira.');
    }
    interceptarResposta(res, (buf, enviar) => {
      if (res.statusCode >= 400) return enviar(buf); // erro do proxy ou do Superlógica: segue igual
      const txt = buf.toString('utf8').replace(/^﻿/, '');
      let j;
      if (/^\s*[{[]/.test(txt)) { try { j = JSON.parse(txt); } catch (e) { j = undefined; } }
      if (j === undefined) {
        if (!geral) return enviar(buf); // PDF, imagem ou texto de um condomínio da carteira
        res.statusCode = 403;
        res.removeHeader('Content-Disposition');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return enviar(JSON.stringify({ erro: 'fora_da_carteira', detalhe: 'Esse arquivo não pode ser conferido com a sua carteira.' }));
      }
      const f = filtrarJson(j, esc.ids, { estrito: geral });
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

  return { escopo, esquecer, esquecerTudo, definirAoNegar, dentroDaCarteira, exigir, guardaRotas, guardaProxy, dentro };
}

module.exports = {
  criarCarteira, temAcao, temModulo, regraDa, idsCondominio, camposDoCorpo, filtrarJson, partesPhp,
  caminhoDecodificado, rotaDoProxy, ehFormulario, idValido, ACAO_TODAS, REGRAS, LEITURA_GERAL,
};
