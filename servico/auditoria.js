// T16: registro de tudo que cada pessoa faz no sistema, e alertas de uso indevido.
// Quem vê: o dono (ação configuracoes.auditoria_total, dada só pelo banco) vê tudo.
// Quem recebe configuracoes.ver_auditoria vê o registro de todos MENOS de quem também
// audita (assim ninguém que o dono liberar enxerga o que o dono faz).

const FUSO = 'America/Sao_Paulo';
const IGNORAR = [/^\/api\/config$/, /^\/api\/audio\/status\//, /^\/api\/atas\/gerar\/status\//, /^\/api\/apresentacao\/status\//, /^\/api\/carteiras\/minha$/];
const JANELA_GET_MS = 2 * 60 * 1000;

function horaSP(d) {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', weekday: 'short', hour12: false }).formatToParts(d);
  const h = parseInt((p.find((x) => x.type === 'hour') || {}).value, 10);
  const dia = String((p.find((x) => x.type === 'weekday') || {}).value || '').toLowerCase();
  return { h, domingo: dia.startsWith('dom') };
}

function idCondominio(req) {
  const p = req.params || {}; const q = req.query || {}; const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const v = p.idSuperlogica || b.id_superlogica || q.idCondominio || q.ID_CONDOMINIO_COND || b.idCondominio || b.ID_CONDOMINIO_COND || null;
  return idValido(v);
}
// Coluna integer: só 1 a 2147483647; o resto vira null (um número absurdo não derruba o lote).
function idValido(v) {
  if (v == null || !/^\d{1,10}$/.test(String(v).trim())) return null;
  const n = Number(String(v).trim());
  return n >= 1 && n <= 2147483647 ? n : null;
}

function criarAuditoria({ banco, perfilDe, temAcao }) {
  const fila = [];
  const vistos = new Map();
  let timer = null;

  function enfileirar(reg) {
    fila.push(reg);
    if (fila.length > 2000) fila.splice(0, fila.length - 2000);
    if (!timer) timer = setTimeout(descarregar, 3000);
  }
  async function descarregar() {
    timer = null;
    if (!fila.length) return;
    const lote = fila.splice(0, 200);
    const r = await banco('POST', '/rest/v1/auditoria', lote).catch(() => ({ status: 0 }));
    if (!(r.status >= 200 && r.status < 300)) {
      console.error('[auditoria] gravação falhou, status ' + r.status + ' (' + lote.length + ' registros)');
      if (r.status === 0 || r.status >= 500) fila.unshift(...lote.slice(0, 500));
      else {
        // Recusa de um registro não pode apagar os outros: grava um por um.
        for (const reg of lote) {
          const r1 = await banco('POST', '/rest/v1/auditoria', reg).catch(() => ({ status: 0 }));
          if (!(r1.status >= 200 && r1.status < 300)) {
            await banco('POST', '/rest/v1/auditoria', Object.assign({}, reg, { detalhe: { recusado: true }, id_superlogica: null })).catch(() => {});
          }
        }
      }
    }
    if (fila.length && !timer) timer = setTimeout(descarregar, 3000);
  }

  function base(req) {
    const u = req.user || {};
    return {
      user_id: u.sub || null,
      email: u.email || null,
      papel: (u.app_metadata && u.app_metadata.role) || null,
      ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64) || null,
      navegador: String(req.headers['user-agent'] || '').slice(0, 200) || null,
    };
  }

  // Marca uso fora do horário (antes das 7h, depois das 21h ou domingo).
  function foraDoHorario() {
    const { h, domingo } = horaSP(new Date());
    return domingo || h < 7 || h >= 21;
  }

  // Evento explícito (ata gerada, transcrição, senha trocada...).
  function evento(req, acao, detalhe, suspeito, motivo) {
    if (req.authMode === 'internal') return;
    const reg = Object.assign(base(req), {
      acao, rota: req.originalUrl ? String(req.originalUrl).split('?')[0].slice(0, 300) : null, metodo: req.method,
      id_superlogica: idValido(detalhe && detalhe.id_superlogica) || idCondominio(req),
      detalhe: detalhe || null, suspeito: !!suspeito, motivo: motivo || (suspeito ? acao : null),
    });
    enfileirar(reg);
  }

  // Middleware: registra cada chamada de quem está logado, ao terminar.
  function middleware(req, res, next) {
    res.on('finish', () => {
      if (!req.user || req.authMode !== 'supabase') return;
      const caminho = String(req.originalUrl || '').split('?')[0];
      if (IGNORAR.some((re) => re.test(caminho))) return;
      const rota = req.route ? (req.baseUrl || '') + req.route.path : caminho.replace(/\/[0-9a-f-]{36}\b/gi, '/:id').replace(/\/\d+\b/g, '/:n');
      const idSL = idCondominio(req);
      if (req.method === 'GET') {
        const chave = req.user.sub + '|' + rota + '|' + (idSL || '');
        const ult = vistos.get(chave);
        if (ult && Date.now() - ult < JANELA_GET_MS && res.statusCode < 400) return;
        vistos.set(chave, Date.now());
        if (vistos.size > 20000) vistos.clear();
      }
      let suspeito = false; let motivo = null;
      // T18: recusa da carteira chega com o motivo (fora_da_carteira, modulo_sem_acesso...).
      if (req._motivoNegado) { suspeito = true; motivo = String(req._motivoNegado).slice(0, 60); }
      else if (res.statusCode === 403) { suspeito = true; motivo = 'acesso_negado'; }
      else if (foraDoHorario()) { suspeito = true; motivo = 'fora_do_horario'; }
      const ehProxy = caminho.startsWith('/api/superlogica/');
      enfileirar(Object.assign(base(req), {
        acao: ehProxy ? 'superlogica ' + req.method + ' ' + caminho.replace('/api/superlogica/v2/condor/', '').slice(0, 120) : req.method + ' ' + rota,
        rota: caminho.slice(0, 300), metodo: req.method, status: res.statusCode, id_superlogica: idSL,
        detalhe: null, suspeito, motivo,
      }));
    });
    next();
  }

  // Quem pode ver o quê.
  async function nivel(req) {
    if (req.authMode === 'internal') return 'dono';
    const p = await perfilDe(req);
    if (temAcao(p, 'configuracoes', 'auditoria_total')) return 'dono';
    if (temAcao(p, 'configuracoes', 'ver_auditoria')) return 'auditor';
    return null;
  }
  async function idsAuditores() {
    const r = await banco('GET', '/rest/v1/profiles?select=id,permissoes');
    if (r.status !== 200 || !Array.isArray(r.body)) return null;
    return r.body.filter((p) => {
      const a = (p.permissoes && p.permissoes.configuracoes && p.permissoes.configuracoes.acoes) || [];
      return a.includes('ver_auditoria') || a.includes('auditoria_total');
    }).map((p) => p.id);
  }
  // Filtro PostgREST de user_id para o auditor (exclui os outros auditores e o dono).
  async function filtroVisivel(req, niv) {
    if (niv === 'dono') return '';
    const ids = await idsAuditores();
    if (!ids) return null;
    const meu = req.user && req.user.sub;
    const fora = ids.filter((id) => id !== meu);
    return fora.length ? '&or=(user_id.is.null,user_id.not.in.(' + fora.join(',') + '))' : '';
  }

  return { middleware, evento, nivel, filtroVisivel, descarregar, idCondominio, foraDoHorario, idValido };
}

module.exports = { criarAuditoria, horaSP };
