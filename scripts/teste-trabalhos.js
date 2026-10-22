// Teste da T49 (trabalhos em andamento): rotas com banco e storage falsos, em memória.
// Confere: cada pessoa só vê e apaga o próprio trabalho, carteira ao salvar, limites,
// assinatura de arquivo, expiração e teto por pessoa.
const express = require('express');
const http = require('http');
const { criarRotasTrabalhos } = require('../servico/trabalhos');

let ok = 0, falha = 0;
const t = (nome, cond) => { if (cond) ok++; else { falha++; console.log('FALHOU: ' + nome); } };

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const linhas = [];
const objetos = new Map();
let seq = 0;
const uuid = () => { seq++; return 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(seq).padStart(12, '0'); };

// Banco falso: entende só os filtros que o módulo usa (eq, gt, lt, order, limit, select).
function filtrar(qs) {
  const p = new URLSearchParams(qs);
  let l = linhas.slice();
  for (const [k, v] of p) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    l = l.filter((x) => op === 'eq' ? String(x[k]) === val : op === 'gt' ? x[k] > val : op === 'lt' ? x[k] < val : true);
  }
  if (p.get('order') === 'atualizado_em.asc') l.sort((a, b) => a.atualizado_em.localeCompare(b.atualizado_em));
  if (p.get('order') === 'atualizado_em.desc') l.sort((a, b) => b.atualizado_em.localeCompare(a.atualizado_em));
  if (p.get('limit')) l = l.slice(0, +p.get('limit'));
  return l;
}
async function banco(metodo, caminho, corpo) {
  const [, qs] = caminho.split('?');
  if (metodo === 'GET') return { status: 200, body: filtrar(qs) };
  if (metodo === 'POST') { const n = { id: uuid(), arquivos: [], criado_em: new Date().toISOString(), ...corpo }; linhas.push(n); return { status: 201, body: [n] }; }
  if (metodo === 'PATCH') { const alvo = filtrar(qs); alvo.forEach((x) => Object.assign(x, corpo)); return { status: 200, body: alvo }; }
  if (metodo === 'DELETE') { const alvo = filtrar(qs); alvo.forEach((x) => linhas.splice(linhas.indexOf(x), 1)); return { status: 200, body: alvo }; }
}

const app = express();
// Login falso: o cabeçalho x-user vira req.user.sub.
const requireAuth = (req, res, next) => { req.user = { sub: req.headers['x-user'] }; next(); };
const carteira = { [A]: ['136', '167'], [B]: ['167'] };
const r = criarRotasTrabalhos(app, {
  requireAuth, express, banco,
  exigirCarteira: async (req, res, id) => { if ((carteira[req.user.sub] || []).includes(id)) return true; res.status(403).json({ erro: 'fora_da_carteira' }); return false; },
  storageUpload: async (b, p, buf) => { objetos.set(p, buf.length); },
  storageSignedUrl: async (b, p) => 'https://x/' + p,
  storageDelete: async (b, p) => { objetos.delete(p); },
});

const srv = http.createServer(app).listen(0, async () => {
  const porta = srv.address().port;
  const pedir = (metodo, caminho, user, corpo, tipo) => new Promise((resolve) => {
    const dados = corpo == null ? null : Buffer.isBuffer(corpo) ? corpo : Buffer.from(JSON.stringify(corpo));
    const q = http.request({ port: porta, path: caminho, method: metodo, headers: { 'x-user': user, ...(dados ? { 'content-type': tipo || 'application/json', 'content-length': dados.length } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ st: res.statusCode, j }); });
    });
    if (dados) q.write(dados); q.end();
  });
  try {
    const s1 = await pedir('PUT', '/api/trabalhos', A, { tipo: 'ata', id_superlogica: 136, titulo: 'Ata AGO Casablanca', dados: { texto: 'x' } });
    t('salva', s1.st === 200 && s1.j.id);
    const id = s1.j.id;
    t('fora da carteira recusa', (await pedir('PUT', '/api/trabalhos', B, { tipo: 'ata', id_superlogica: 136, titulo: 'Ata', dados: {} })).st === 403);
    t('tipo inválido', (await pedir('PUT', '/api/trabalhos', A, { tipo: 'outro', titulo: 'Ata x', dados: {} })).st === 400);
    t('título curto', (await pedir('PUT', '/api/trabalhos', A, { tipo: 'ata', titulo: 'a', dados: {} })).st === 400);
    t('sem dados', (await pedir('PUT', '/api/trabalhos', A, { tipo: 'ata', titulo: 'Ata x' })).st === 400);
    t('lista do dono', (await pedir('GET', '/api/trabalhos', A)).j.itens.length === 1);
    t('outra pessoa não vê na lista', (await pedir('GET', '/api/trabalhos', B)).j.itens.length === 0);
    t('outra pessoa não abre', (await pedir('GET', '/api/trabalhos/' + id, B)).st === 404);
    const ab = await pedir('GET', '/api/trabalhos/' + id, A);
    t('dono abre com dados', ab.st === 200 && ab.j.dados.texto === 'x');
    const s2 = await pedir('PUT', '/api/trabalhos', A, { id, tipo: 'ata', id_superlogica: 136, titulo: 'Ata AGO Casablanca 2', dados: { texto: 'y' } });
    t('atualiza o mesmo id', s2.j.id === id && linhas.length === 1 && linhas[0].dados.texto === 'y');
    t('outra pessoa não atualiza (cria o dela)', (await pedir('PUT', '/api/trabalhos', B, { id, tipo: 'ata', id_superlogica: 167, titulo: 'Ata do B', dados: { texto: 'b' } })).j.id !== id && linhas.find((x) => x.id === id).dados.texto === 'y');
    t('id inválido', (await pedir('GET', '/api/trabalhos/abc', A)).st === 400);
    t('arquivo que não é PDF recusa', (await pedir('POST', '/api/trabalhos/' + id + '/arquivo?nome=x.pdf', A, Buffer.from('nao pdf'), 'application/octet-stream')).st === 415);
    t('nome de arquivo ruim recusa', (await pedir('POST', '/api/trabalhos/' + id + '/arquivo?nome=../x.pdf', A, Buffer.from('%PDF-1'), 'application/octet-stream')).st === 400);
    t('anexa PDF', (await pedir('POST', '/api/trabalhos/' + id + '/arquivo?nome=Prestacao.pdf', A, Buffer.from('%PDF-1.4 teste'), 'application/octet-stream')).st === 200 && objetos.size === 1);
    t('outra pessoa não anexa', (await pedir('POST', '/api/trabalhos/' + id + '/arquivo?nome=y.pdf', B, Buffer.from('%PDF-1.4'), 'application/octet-stream')).st === 404);
    const ab2 = await pedir('GET', '/api/trabalhos/' + id, A);
    t('abre com link do arquivo', ab2.j.arquivos.length === 1 && /Prestacao\.pdf$/.test(ab2.j.arquivos[0].url));
    t('outra pessoa não encerra', (await pedir('DELETE', '/api/trabalhos/' + id, B)).st === 200 && linhas.some((x) => x.id === id));
    t('dono encerra e apaga arquivo', (await pedir('DELETE', '/api/trabalhos/' + id, A)).st === 200 && !linhas.some((x) => x.id === id) && objetos.size === 0);
    // Expirado some da lista e é apagado pela limpeza.
    linhas.push({ id: uuid(), user_id: A, tipo: 'ata', titulo: 'velha', dados: {}, arquivos: [], atualizado_em: '2026-01-01T00:00:00.000Z', expira_em: '2026-01-08T00:00:00.000Z' });
    t('expirado fora da lista', (await pedir('GET', '/api/trabalhos', A)).j.itens.length === 0);
    await r.limparExpirados();
    t('limpeza apaga expirado', !linhas.some((x) => x.titulo === 'velha'));
    // Teto por pessoa: o 21º apaga o mais antigo.
    for (let i = 0; i < 21; i++) await pedir('PUT', '/api/trabalhos', A, { tipo: 'previsao', id_superlogica: 167, titulo: 'Previsão ' + i, dados: { i } });
    const doA = linhas.filter((x) => x.user_id === A);
    t('teto de 20 por pessoa', doA.length === 20 && !doA.some((x) => x.titulo === 'Previsão 0'));
    t('sem usuário não lista', (await pedir('GET', '/api/trabalhos', 'nao-e-uuid')).j.itens.length === 0);
  } catch (e) { t('sem exceção: ' + e.message, false); }
  srv.close();
  console.log((falha ? 'FALHOU: ' : 'OK: ') + ok + ' certos, ' + falha + ' falhas');
  process.exit(falha ? 1 : 0);
});
