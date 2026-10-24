// Testes da conta do Superlógica de cada pessoa e do botão "Abrir no Superlógica"
// (servico/superlogica-conta.js), sem rede: banco em memória no formato do PostgREST, login pelo
// cabeçalho de teste e relógio controlado para o link de uso único. Nenhum login de verdade.
// Uso: NODE_PATH=<repo>/node_modules node scripts/teste-superlogica-conta.js
const http = require('http');
const crypto = require('crypto');
const express = require('express');
process.env.NODE_ENV = 'test';
const SC = require('../servico/superlogica-conta');
SC.decifrar = SC.decifrarParaTeste;

let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

const SENHA = 'Senha#Superlogica-Teste-4471';
const SENHA2 = 'OutraSenha!Bem$Diferente90';
const ENV = { SUPERLOGICA_CRED_CHAVE: 'chave-de-teste-com-mais-de-trinta-e-dois-caracteres-abcdef' };
const ENV_SEM = {};
const A = crypto.randomUUID(), B = crypto.randomUUID();

// Tudo o que for escrito no console (para conferir que a senha nunca aparece).
const saida = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
['log', 'warn', 'error'].forEach((k) => { console[k] = function () { saida.push([].slice.call(arguments).join(' ')); return orig[k].apply(console, arguments); }; });

// ── 1. Cifra ──
{
  const fora = require('child_process').execFileSync(process.execPath, ['-e', "const m=require('./servico/superlogica-conta');process.stdout.write(typeof m.decifrar+','+typeof m.decifrarParaTeste)"],
    { cwd: require('path').join(__dirname, '..'), env: Object.assign({}, process.env, { NODE_ENV: 'production' }) }).toString();
  t('decifrar não sai do módulo fora dos testes', fora === 'undefined,undefined');
}
const c1 = SC.cifrar(SENHA, A, ENV);
t('cifrado não contém a senha', !c1.includes(SENHA) && c1.startsWith('v1:'));
t('decifra com o mesmo usuário', SC.decifrar(c1, A, ENV) === SENHA);
t('não decifra com outro usuário', SC.decifrar(c1, B, ENV) === null);
t('não decifra com outra chave', SC.decifrar(c1, A, { SUPERLOGICA_CRED_CHAVE: 'x'.repeat(40) }) === null);
t('não decifra valor estragado', SC.decifrar(c1.slice(0, -4) + 'AAAA', A, ENV) === null);
t('duas cifras da mesma senha são diferentes', SC.cifrar(SENHA, A, ENV) !== c1);
let semChave = null; try { SC.cifrar(SENHA, A, ENV_SEM); } catch (e) { semChave = e.code; }
t('sem chave não cifra', semChave === 'sem_chave');
let chaveCurta = null; try { SC.cifrar(SENHA, A, { SUPERLOGICA_CRED_CHAVE: 'curta' }); } catch (e) { chaveCurta = e.code; }
t('chave curta não vale', chaveCurta === 'sem_chave');

// ── 2. Validação e tela ──
t('email inválido recusa', !SC.validar({ email: 'semarroba', senha: SENHA }, null).ok);
t('conta nova sem senha recusa', !SC.validar({ email: 'a@b.com' }, null).ok);
t('troca sem senha mantém', SC.validar({ email: 'a@b.com' }, { email: 'a@b.com' }).ok && SC.validar({ email: 'a@b.com' }, { email: 'a@b.com' }).senha === null);
t('senha com quebra de linha recusa', !SC.validar({ email: 'a@b.com', senha: 'a\nb' }, null).ok);
const tela = SC.contaParaTela({ user_id: A, email: 'a@b.com', senha_cifrada: c1, atualizado_em: 'x' });
t('tela só vê senha guardada', tela.senha_guardada === true && !JSON.stringify(tela).includes(c1) && !('senha_cifrada' in tela));

// ── 3. Destino ──
t('destino documentos', SC.montarDestino('documentos', {}).url === 'https://condominioes.superlogica.net/clients/condor/impressoes/index');
t('destino desconhecido recusa', SC.montarDestino('https://mal.exemplo/x', {}) === null && SC.montarDestino('__proto__', {}) === null);
t('base fora do superlogica volta ao padrão', SC.telaBase({ SUPERLOGICA_TELA_BASE: 'https://mal.exemplo' }) === 'https://condominioes.superlogica.net');
t('base http recusa', SC.telaBase({ SUPERLOGICA_TELA_BASE: 'http://outra.superlogica.net' }) === 'https://condominioes.superlogica.net');
t('base de outra licença aceita', SC.telaBase({ SUPERLOGICA_TELA_BASE: 'https://outra.superlogica.net/' }) === 'https://outra.superlogica.net');

// ── 4. Link de uso único ──
let relogio = 1000000;
const L = SC.criarLinks({ agora: () => relogio });
const k1 = L.emitir(A, 'https://condominioes.superlogica.net/x');
t('primeiro uso vale', L.consumir(k1, A).ok === true);
t('segundo uso recusa', L.consumir(k1, A).motivo === 'nao_existe');
const k2 = L.emitir(A, 'u');
relogio += SC.LINK_VALIDADE_MS + 1;
t('vencido recusa', L.consumir(k2, A).motivo === 'vencido');
const k3 = L.emitir(A, 'u');
t('outro usuário recusa', L.consumir(k3, B).motivo === 'outro_usuario');
t('depois de outro tentar, nem o dono usa', L.consumir(k3, A).ok === false);
t('token inventado recusa', L.consumir('x'.repeat(43), A).motivo === 'nao_existe' && L.consumir('', A).motivo === 'nao_existe');
const k4 = L.emitir(A, 'u'); relogio += SC.LINK_VALIDADE_MS - 5;
t('dentro dos 60 segundos vale', L.consumir(k4, A).ok === true);

// ── 5. Rotas ──
function criarBanco() {
  const linhas = [];
  const filtro = (q) => { const m = /user_id=eq\.([0-9a-f-]+)/i.exec(q); return m ? m[1] : null; };
  const pedidos = [];
  async function banco(metodo, caminho, corpo) {
    pedidos.push({ metodo, caminho, corpo });
    if (!caminho.startsWith('/rest/v1/superlogica_contas')) return { status: 404, body: null };
    const id = filtro(caminho);
    if (metodo === 'GET') return { status: 200, body: linhas.filter((l) => l.user_id === id).map((l) => Object.assign({}, l)) };
    if (metodo === 'POST') { if (linhas.some((l) => l.user_id === corpo.user_id)) return { status: 409, body: null }; const l = Object.assign({}, corpo); linhas.push(l); return { status: 201, body: [l] }; }
    if (metodo === 'PATCH') { const l = linhas.find((x) => x.user_id === id); if (!l) return { status: 200, body: [] }; Object.assign(l, corpo); return { status: 200, body: [Object.assign({}, l)] }; }
    if (metodo === 'DELETE') { const i = linhas.findIndex((x) => x.user_id === id); const fora = i >= 0 ? linhas.splice(i, 1) : []; return { status: 200, body: fora }; }
    return { status: 400, body: null };
  }
  return { banco, linhas, pedidos };
}

(async () => {
  const fb = criarBanco();
  const eventos = [];
  const envAtual = { v: ENV };
  let relogio2 = 5000000;
  const links = SC.criarLinks({ agora: () => relogio2 });
  const JWT = { ['jwt-a']: { sub: A }, ['jwt-b']: { sub: B } };
  const app = express();
  SC.criarRotasContaSuperlogica(app, {
    requireAuth: (req, res, next) => {
      const u = req.headers['x-teste'];
      if (u === 'interno') { req.authMode = 'internal'; return next(); }
      if (!u) return res.status(401).end();
      req.user = { sub: u }; req.authMode = 'supabase'; next();
    },
    express, banco: fb.banco, links,
    auditoria: { evento: (req, acao, det, suspeito) => eventos.push({ acao, det, suspeito, quem: req.user && req.user.sub }) },
    verificarUsuario: async (jwt) => JWT[jwt] || null,
    get env() { return envAtual.v; },
  });
  const srv = app.listen(0);
  const porta = srv.address().port;
  // Pedido de teste: corpo JSON ou formulário; devolve status, cabeçalhos, JSON e texto.
  const pedir = (quem, metodo, caminho, corpo, form) => new Promise((ok2) => {
    const buf = corpo == null ? null : Buffer.from(form ? new URLSearchParams(corpo).toString() : JSON.stringify(corpo));
    const h = Object.assign({}, quem ? { 'x-teste': quem } : {}, buf ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': buf.length } : {});
    const r = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: h }, (res) => {
      const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => {
        const txt = Buffer.concat(p).toString(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
        ok2({ status: res.statusCode, h: res.headers, j, txt });
      });
    });
    if (buf) r.write(buf);
    r.end();
  });
  const respostas = [];
  const guardar = (r) => { respostas.push(r.txt); return r; };

  // Sem chave configurada: não salva nada.
  envAtual.v = ENV_SEM;
  let r = guardar(await pedir(A, 'PUT', '/api/conta-superlogica', { email: 'pessoa.a@exemplo.com', senha: SENHA }));
  t('sem chave responde 503', r.status === 503 && r.j.erro === 'sem_chave');
  t('sem chave nada no banco', fb.linhas.length === 0);
  r = guardar(await pedir(A, 'GET', '/api/conta-superlogica'));
  t('sem chave a tela sabe', r.status === 200 && r.j.chave_configurada === false && r.j.conta === null);
  envAtual.v = ENV;

  // A grava a própria conta.
  r = guardar(await pedir(A, 'PUT', '/api/conta-superlogica', { email: 'Pessoa.A@Exemplo.com', senha: SENHA, user_id: B }));
  t('A grava', r.status === 200 && r.j.conta.email === 'pessoa.a@exemplo.com' && r.j.conta.senha_guardada === true);
  t('gravou no id de A, não no do corpo', fb.linhas.length === 1 && fb.linhas[0].user_id === A);
  t('banco guarda cifrado e abre só com A', fb.linhas[0].senha_cifrada !== SENHA && SC.decifrar(fb.linhas[0].senha_cifrada, A, ENV) === SENHA && SC.decifrar(fb.linhas[0].senha_cifrada, B, ENV) === null);
  t('resposta sem senha cifrada', !r.txt.includes('senha_cifrada') && !r.txt.includes(fb.linhas[0].senha_cifrada));
  t('cache no-store', /no-store/.test(r.h['cache-control'] || ''));

  // B não vê nem mexe na de A.
  r = guardar(await pedir(B, 'GET', '/api/conta-superlogica'));
  t('B não vê a conta de A', r.status === 200 && r.j.conta === null);
  r = guardar(await pedir(B, 'DELETE', '/api/conta-superlogica'));
  t('B apagar não apaga a de A', r.status === 200 && fb.linhas.length === 1 && fb.linhas[0].user_id === A);
  r = guardar(await pedir('interno', 'PUT', '/api/conta-superlogica', { email: 'x@exemplo.com', senha: SENHA2 }));
  t('chave interna não grava', r.status === 403 && fb.linhas.length === 1);
  r = guardar(await pedir('interno', 'GET', '/api/conta-superlogica'));
  t('chave interna não lê', r.status === 403);
  r = guardar(await pedir('nao-e-uuid', 'PUT', '/api/conta-superlogica', { email: 'x@exemplo.com', senha: SENHA2 }));
  t('sessão sem id válido não grava', r.status === 403);

  // A troca só o email (senha mantém) e depois a senha.
  const cifradoAntes = fb.linhas[0].senha_cifrada;
  r = guardar(await pedir(A, 'PUT', '/api/conta-superlogica', { email: 'nova.a@exemplo.com' }));
  t('troca o email e mantém a senha', r.status === 200 && fb.linhas[0].email === 'nova.a@exemplo.com' && fb.linhas[0].senha_cifrada === cifradoAntes);
  r = guardar(await pedir(A, 'PUT', '/api/conta-superlogica', { email: 'nova.a@exemplo.com', senha: SENHA2 }));
  t('troca a senha', r.status === 200 && SC.decifrar(fb.linhas[0].senha_cifrada, A, ENV) === SENHA2);
  r = guardar(await pedir(A, 'GET', '/api/conta-superlogica'));
  t('A lê só senha guardada', r.status === 200 && r.j.conta.senha_guardada === true && r.j.conta.email === 'nova.a@exemplo.com' && !r.txt.includes('v1:'));

  // Abrir no Superlógica: link de uso único pela aba nova.
  r = guardar(await pedir(A, 'POST', '/api/conta-superlogica/abrir', { destino: 'https://mal.exemplo' }));
  t('destino livre recusa', r.status === 400);
  r = guardar(await pedir(A, 'POST', '/api/conta-superlogica/abrir', { destino: 'documentos', id_superlogica: '1 or 1' }));
  t('condomínio inválido recusa', r.status === 400);
  r = guardar(await pedir('interno', 'POST', '/api/conta-superlogica/abrir', { destino: 'documentos' }));
  t('chave interna não pede link', r.status === 403);
  r = guardar(await pedir(A, 'POST', '/api/conta-superlogica/abrir', { destino: 'documentos', id_superlogica: 167 }));
  t('A pede o link', r.status === 200 && typeof r.j.token === 'string' && r.j.token.length >= 40 && r.j.modo === 'C' && r.j.validade_segundos === 60 && r.j.email === 'nova.a@exemplo.com');
  t('link não traz endereço nem senha', !r.txt.includes('superlogica.net') && !r.txt.includes(SENHA2));
  const tok = r.j.token;
  r = guardar(await pedir(null, 'POST', '/api/conta-superlogica/ir', { token: tok, acesso: 'jwt-a' }, true));
  t('primeiro uso leva ao Superlógica', r.status === 303 && r.h.location === 'https://condominioes.superlogica.net/clients/condor/impressoes/index');
  t('passagem com no-store e política restrita', /no-store/.test(r.h['cache-control'] || '') && /default-src 'none'/.test(r.h['content-security-policy'] || '') && r.h['referrer-policy'] === 'no-referrer');
  t('endereço do destino sem senha', !String(r.h.location).includes(SENHA2) && !String(r.h.location).includes('senha'));
  r = guardar(await pedir(null, 'POST', '/api/conta-superlogica/ir', { token: tok, acesso: 'jwt-a' }, true));
  t('segundo uso recusa', r.status === 410 && /já foi usado/.test(r.txt) && !r.h.location);

  r = guardar(await pedir(A, 'POST', '/api/conta-superlogica/abrir', { destino: 'documentos' }));
  const tokB = r.j.token;
  r = guardar(await pedir(null, 'POST', '/api/conta-superlogica/ir', { token: tokB, acesso: 'jwt-b' }, true));
  t('outro usuário recusa', r.status === 403 && !r.h.location);
  t('tentativa de outro usuário fica marcada', eventos.some((e) => e.acao === 'superlogica_link_recusado' && e.det.motivo === 'outro_usuario' && e.suspeito === true && e.quem === B));
  r = guardar(await pedir(null, 'POST', '/api/conta-superlogica/ir', { token: tokB, acesso: 'jwt-a' }, true));
  t('depois do outro, o dono também não usa', r.status === 410);

  r = guardar(await pedir(A, 'POST', '/api/conta-superlogica/abrir', { destino: 'documentos' }));
  const tokV = r.j.token;
  relogio2 += 61 * 1000;
  r = guardar(await pedir(null, 'POST', '/api/conta-superlogica/ir', { token: tokV, acesso: 'jwt-a' }, true));
  t('vencido recusa', r.status === 410 && /venceu/.test(r.txt));

  r = guardar(await pedir(A, 'POST', '/api/conta-superlogica/abrir', { destino: 'documentos' }));
  r = guardar(await pedir(null, 'POST', '/api/conta-superlogica/ir', { token: r.j.token, acesso: 'jwt-invalido' }, true));
  t('sem sessão do Hub recusa', r.status === 401 && !r.h.location);
  r = guardar(await pedir(null, 'GET', '/api/conta-superlogica/ir?token=' + tok + '&acesso=jwt-a'));
  t('link por endereço não existe', r.status === 404);

  // A apaga a própria conta.
  r = guardar(await pedir(A, 'DELETE', '/api/conta-superlogica'));
  t('A apaga', r.status === 200 && fb.linhas.length === 0);

  // Auditoria e respostas sem a senha.
  const acoes = eventos.map((e) => e.acao);
  t('auditoria de gravar, trocar e apagar', acoes.includes('superlogica_conta_gravada') && acoes.includes('superlogica_conta_trocada') && acoes.includes('superlogica_conta_apagada'));
  const tudoAuditoria = JSON.stringify(eventos);
  t('auditoria sem senha', ![SENHA, SENHA2].some((s) => tudoAuditoria.includes(s)) && !tudoAuditoria.includes('v1:'));
  const tudoResp = respostas.join('\n');
  t('nenhuma resposta com a senha', ![SENHA, SENHA2].some((s) => tudoResp.includes(s)) && !/v1:[A-Za-z0-9+/=]+:/.test(tudoResp));
  t('nenhum log com a senha', ![SENHA, SENHA2].some((s) => saida.join('\n').includes(s)));
  t('pedidos ao banco só com a senha cifrada', !JSON.stringify(fb.pedidos).includes(SENHA) && !JSON.stringify(fb.pedidos).includes(SENHA2));

  srv.close();
  orig.log((falhou ? 'FALHOU ' : 'OK ') + ok + ' de ' + (ok + falhou));
  process.exit(falhou ? 1 : 0);
})();
