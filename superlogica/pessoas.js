// Conferência dos participantes citados na ata (T07): nome e unidade contra o cadastro do
// Superlógica (unidades/index com contatos e sindicos/index). Só leitura. Devolve só o que a
// conferência precisa (nomes por unidade); nada de CPF, email ou telefone sai daqui.

const cadastro = require('./cadastro');
const POR_PAGINA = 50;
const MAX_PAGINAS = 30; // 1.500 unidades; acima disso confere só o que leu (resultado parcial)
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const norm = (v) => limpar(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// chave de unidade comparável: só letras e dígitos, zeros à esquerda fora dos números
const chaveUni = (v) => norm(v).replace(/[^a-z0-9]/g, '').replace(/(^|[a-z])0+(\d)/g, '$1$2');

const TTL_MS = 10 * 60 * 1000;
const TTL_ERRO_MS = 2 * 60 * 1000;
const _cache = new Map(); // id -> { ate, p }  (a promessa fica no cache: pedidos juntos esperam a mesma leitura)

// Bloco como vem do cadastro ("BLOCO J", "Torre 2") vira só o código ("j", "2").
const soBloco = (v) => limpar(v).replace(/^(bloco|torre|bl\.?)\s*/i, '');

function carregarPessoas(cliente, id) {
  const k = String(id);
  const c = _cache.get(k);
  if (c && c.ate > Date.now()) return c.p;
  const p = _lerPessoas(cliente, k);
  _cache.set(k, { ate: Date.now() + TTL_MS, p });
  if (_cache.size > 200) _cache.delete(_cache.keys().next().value);
  // erro fica em cache por pouco tempo (não repete 30 leituras a cada geração)
  p.catch(() => { const e = _cache.get(k); if (e && e.p === p) e.ate = Date.now() + TTL_ERRO_MS; });
  return p;
}

async function _lerPessoas(cliente, id) {
  const unidades = [];
  let parcial = false;
  for (let pg = 1; pg <= MAX_PAGINAS; pg++) {
    const j = await cliente.get('unidades/index', { idCondominio: id, exibirDadosDosContatos: 1, itensPorPagina: POR_PAGINA, pagina: pg });
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((u) => unidades.push(u));
    if (j.length < POR_PAGINA) break;
    if (pg === MAX_PAGINAS) parcial = true;
  }
  const sind = await cliente.get('sindicos/index', { idCondominio: id }).catch(() => []);
  // Por número da unidade: quantos blocos têm aquele número (chave só do número só vale se for único)
  const blocosPorNumero = new Map();
  unidades.forEach((u) => { const n = chaveUni(u.st_unidade_uni); blocosPorNumero.set(n, (blocosPorNumero.get(n) || 0) + 1); });
  const mapa = new Map(); // chave -> [{ rotulo, nomes }]
  unidades.forEach((u) => {
    const uni = limpar(u.st_unidade_uni);
    const bl = soBloco(u.st_bloco_uni);
    const nomes = new Set();
    [u.nome_proprietario, u.st_sacado_uni].forEach((n) => { if (limpar(n)) nomes.add(limpar(n)); });
    (Array.isArray(u.contatos) ? u.contatos : []).forEach((ct) => { if (limpar(ct.st_nome_con)) nomes.add(limpar(ct.st_nome_con)); });
    const rotulo = uni + (bl ? ' ' + bl : '');
    // Mesma unidade aceita várias grafias: "J203", "203 J", e "203" só quando nenhum outro bloco tem 203.
    const chaves = new Set([chaveUni(uni + bl), chaveUni(bl + uni)]);
    if (blocosPorNumero.get(chaveUni(uni)) === 1) chaves.add(chaveUni(uni));
    chaves.forEach((k) => {
      if (!k) return;
      if (!mapa.has(k)) mapa.set(k, []);
      mapa.get(k).push({ rotulo, nomes: [...nomes] });
    });
  });
  // Só o síndico com mandato VIGENTE (mesma regra do cadastro; subsíndico e conselho fora).
  const hoje = new Date();
  const sindicos = (Array.isArray(sind) ? sind : [])
    .filter((s) => s && limpar(s.st_nome_sin) && cadastro.vigente(s, hoje) && cadastro.RE_SINDICO.test(s.st_cargo_sin || '') && !cadastro.RE_SUBSINDICO.test(s.st_cargo_sin || ''))
    .map((s) => limpar(s.st_nome_sin));
  return { porUnidade: mapa, sindicos, total_unidades: unidades.length, parcial };
}

// Palavras do nome que identificam a pessoa (sem tratamento nem conectivo).
const _NAO_NOME = new Set(['sr', 'sra', 'srta', 'dr', 'dra', 'dona', 'da', 'de', 'do', 'das', 'dos', 'e', 'a', 'confirmar', 'sobrenome', 'nome']);
function palavrasNome(n) {
  return norm(String(n).replace(/\[[^\]]*\]/g, ' ')).split(/[^a-z]+/).filter((w) => w.length >= 3 && !_NAO_NOME.has(w));
}
// Chave fonética simples do português (a transcrição troca K por C, Y por I, PH por F...).
function fonetica(w) {
  return String(w).replace(/^h/, '').replace(/ph/g, 'f').replace(/k/g, 'c').replace(/y/g, 'i').replace(/w/g, 'v')
    .replace(/ç/g, 's').replace(/z/g, 's').replace(/qu/g, 'c').replace(/(.)\1+/g, '$1');
}
function nomeParecido(nomeAta, nomesCadastro) {
  const ws = palavrasNome(nomeAta).map(fonetica);
  if (!ws.length) return false;
  return nomesCadastro.some((nc) => {
    const wc = new Set(palavrasNome(nc).map(fonetica));
    return wc.has(ws[0]) && ws.slice(1).every((w) => wc.has(w));
  });
}
function nomeBate(nomeAta, nomesCadastro) {
  const ws = palavrasNome(nomeAta);
  if (!ws.length) return null; // sem nome legível: não dá para conferir
  return nomesCadastro.some((nc) => {
    const wc = new Set(palavrasNome(nc));
    // o primeiro nome tem que existir no cadastro; demais palavras ditas também, se houver
    return wc.has(ws[0]) && ws.slice(1).every((w) => wc.has(w));
  });
}

// Acha na ata pares "nome + unidade" ("Sra. Cátia, da unidade J203", "Sr. João (apto 101)").
// Devolve a conferência de cada par. Não altera a ata.
// Janela curta (até 15 caracteres) e conector antes da palavra unidade ("Sra. X, da unidade",
// "Sr. X (apto 101)"): evita ligar a pessoa a uma unidade só citada na mesma frase.
// Letra da unidade colada ao número ("J203", "203J") ou maiúscula isolada ("203 J").
const RE_PAR = /((?:Sr\.|Sra\.|Dr\.|Dra\.|[Cc]ond[ôo]min[oa]|[Mm]orador(?:a)?|[Pp]ropriet[áa]ri[oa]|[Ii]nquilin[oa])\s+(?:\[[^\]]*\]\s+)?((?:[A-ZÀ-Ý][A-Za-zà-ÿ]+(?:\s+(?:d[aeo]s?\s+)?|\s*)){1,5}))(?:\s*\[[^\]]*\])*[^.;:\n\[]{0,15}?(?:\(|,|\bd[ao]\b|\bn[ao]\b)\s*(?:unidade|apartamento|apto\.?|ap\.?|casa|sala|lote)\s+(?:n[ºo°]\s*)?([A-Za-z]?-?\d{1,5}(?:-?[A-Za-z](?![a-zà-ÿ]))?(?:\s[A-Z](?=[\s,.;:)]|$))?(?:\s*(?:bloco|torre)\s*[A-Za-z0-9]{1,3})?)/g;

// C08: o gate de saída troca nome sem apoio por "[nome sem âncora na fonte: 'Kátia']" e o modelo
// escreve "[sobrenome a confirmar]"; com isso o par nome e unidade sumia e o quadro não aparecia.
// Antes de procurar os pares: o nome marcado pelo gate volta ao texto e as demais marcas saem.
function semMarcas(txt) {
  return String(txt || '')
    .replace(/\[(?:nome sem âncora na fonte|voto atribuído a nome sem âncora):\s*['"]?([^\]'"]*)['"]?\]/g, '$1')
    .replace(/\s*\[[^\]\n]{0,120}\]/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

function conferirParticipantes(ataTxt, pessoas) {
  const s = semMarcas(ataTxt);
  const vistos = new Set();
  const itens = [];
  let m;
  RE_PAR.lastIndex = 0;
  while ((m = RE_PAR.exec(s))) {
    const nome = limpar(m[2]);
    const uniTxt = limpar(m[3]).replace(/\s*(bloco|torre)\s*/i, ' ');
    const chave = norm(nome) + '|' + chaveUni(uniTxt);
    if (!nome || vistos.has(chave)) continue;
    vistos.add(chave);
    const cands = pessoas.porUnidade.get(chaveUni(uniTxt)) || pessoas.porUnidade.get(chaveUni(uniTxt.split(' ').reverse().join(''))) || [];
    let situacao;
    if (!cands.length) situacao = 'unidade_nao_encontrada';
    else {
      const nomesCad = [].concat(...cands.map((c) => c.nomes));
      const bate = nomeBate(nome, nomesCad);
      situacao = bate === null ? 'sem_nome' : bate ? 'ok' : nomeParecido(nome, nomesCad) ? 'nome_parecido' : 'nome_nao_bate';
    }
    if (situacao === 'sem_nome') continue;
    const item = { nome, unidade: uniTxt, situacao, unidade_cadastro: cands.length ? cands[0].rotulo : '' };
    // Para o revisor corrigir: nomes do cadastro daquela unidade (a tela é de quem já tem acesso ao Superlógica).
    if (situacao === 'nome_nao_bate' || situacao === 'nome_parecido') item.nomes_cadastro = [].concat(...cands.map((c) => c.nomes)).slice(0, 6);
    itens.push(item);
  }
  return { itens, divergentes: itens.filter((i) => i.situacao !== 'ok'), parcial: !!pessoas.parcial };
}

// Síndico citado na ata (texto "síndic[oa] Sr./Sra. Nome") confere com sindicos/index.
function conferirSindico(ataTxt, pessoas) {
  const m = semMarcas(ataTxt).match(/s[íi]ndic[oa]\s*,?\s*(?:Sr\.|Sra\.)\s+((?:[A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:d[aeo]s?\s+)?|\s*)){1,5})/);
  if (!m || !pessoas.sindicos.length) return null;
  const nome = limpar(m[1]);
  const bate = nomeBate(nome, pessoas.sindicos);
  if (bate === null) return null;
  return { nome, situacao: bate ? 'ok' : nomeParecido(nome, pessoas.sindicos) ? 'nome_parecido' : 'nome_nao_bate', cadastro: pessoas.sindicos };
}

module.exports = { carregarPessoas, conferirParticipantes, conferirSindico, nomeBate, chaveUni };
