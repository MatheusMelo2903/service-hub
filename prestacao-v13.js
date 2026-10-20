'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Prestação de contas v13: o MESMO motor da skill powerpoint-prestacao-contas.
//
// Fluxo (em segundo plano, com job + polling, igual à ata: o edge do Railway
// segura o corpo da resposta e o Safari derruba conexão parada por muito tempo):
//   1. prestacao-pdf /v13/extrair  PDFs + período -> dados + rascunho (números da skill)
//   2. Claude (créditos da API)    rascunho -> composição legível (só texto, nunca número)
//   3. prestacao-pdf /v13/montar   dados + composição -> PPTX e PDF auditados
// Se a etapa 2 falhar ou não passar na conferência, o microserviço monta com a
// composição automática (regras, sem IA). Número nenhum passa pela IA: os valores
// do deck saem do dados.json e a conferência do montar.py recusa soma que não bate.
//
// Rotas:
//   POST /api/prestacao/v13/iniciar?nome=&obs=   multipart (arquivos, inicio, fim) -> 202 { jobId }
//   GET  /api/prestacao/v13/status/:jobId        processing | done (arquivos) | error (detalhe)
//
// Regras de estilo da composição: skills-server/prestacao-v13 (cópia das
// references da skill; sincronizar com scripts/sincronizar-skill-prestacao.sh).
// Assunção: instância única (o store de jobs é em memória, como o da ata).
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MODELO = process.env.PRESTACAO_MODELO || 'claude-sonnet-4-6';
const TAMANHO_MAX = 50 * 1024 * 1024;
const MAX_ITENS_PROMPT = 60;     // itens por rubrica enviados à IA (do maior pro menor)
// O prompt pede 260; aceita até 300 porque o teste com o Bosque (272 rubricas)
// mostrou que até 300 cabe no cartão largo e passa na auditoria visual.
const LIMITE_TEXTO = 300;
const LIMITE_NOME_RECEITA = 30;  // cabe numa linha da tabela "Todas as fontes de receita"
const MAX_JOBS_ATIVOS_POR_USUARIO = 2;
const MAX_JOBS_ATIVOS_GERAL = 4;      // cada job segura o upload e chama o LibreOffice
const LIMPEZA_MS = 15 * 60 * 1000;

function lerReferencia(nome) {
  try {
    return fs.readFileSync(path.join(__dirname, 'skills-server', 'prestacao-v13', nome), 'utf8');
  } catch (e) {
    console.warn('[prestacao-v13] referência ausente: ' + nome);
    return '';
  }
}
const COMPOSICAO_MD = lerReferencia('composicao.md');
const EXEMPLO_BURITIS = lerReferencia('exemplo_composicao_buritis.json');

const SYSTEM_PROMPT = [
  'Você faz a curadoria da composição de uma prestação de contas de condomínio no padrão aprovado do Grupo Service.',
  'Recebe os números já extraídos e conferidos dos relatórios do Superlógica. Seu trabalho é só escrever os textos.',
  'Siga as regras abaixo à risca.',
  '',
  COMPOSICAO_MD,
  '',
  '## Régua de estilo (curadoria aprovada do Condomínio Buritis)',
  EXEMPLO_BURITIS,
  '',
  '## Formato da resposta',
  'Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois e sem cercas de código, com estas chaves:',
  '{"rubricas": {"<chave exata da rubrica>": {"texto": "...", "fecha": true, "nome": "opcional, só para arrumar a grafia do nome"}},',
  ' "categorias": {"<nome exato da categoria>": {"desc": "opcional", "nota": "opcional"}},',
  ' "receitas_nomes": {"<nome exato da receita>": "nome com grafia arrumada"},',
  ' "receita_insight": "uma frase curta sobre a receita, com números recebidos"}',
  '',
  'Regras do JSON:',
  '1. Use as chaves exatamente como vieram (campo "chave" das rubricas, "nome" das categorias e receitas). Escreva uma entrada para cada rubrica recebida.',
  '2. Valores sempre no formato R$ 1.234,56 e só valores que aparecem nos itens ou totais recebidos. Nunca invente item, valor, data ou fornecedor.',
  '2b. Em cada item, "valor" já é a SOMA de todos os lançamentos dele e "qtd" é quantos lançamentos são. Nunca multiplique valor por qtd. Pode juntar itens somando os valores deles; nunca divida um item em partes nem crie "outros" com valor calculado para fechar a soma.',
  '3. "fecha": true só quando os valores citados no texto somam exatamente o total da rubrica. Na dúvida, false.',
  '4. Rubrica com "conciliada": false: escreva sem valores e com "fecha": false.',
  '5. Rubrica recorrente sem descrição: use {n} para o número de meses, como nas regras.',
  '6. Texto com no máximo 260 caracteres. Nenhum hífen ou travessão no texto.',
  '6b. Nome em receitas_nomes com no máximo 30 caracteres (precisa caber numa linha da tabela).',
  '7. "nota" de categoria só quando antecipa pergunta de assembleia, no máximo uma por categoria, com números recebidos.',
  '8. As observações do usuário, quando vierem, só orientam a ênfase dos textos. Nunca mudam números.',
].join('\n');

// ── HTTP helpers ─────────────────────────────────────────────────────────
function requisitar(urlCompleta, { method = 'POST', headers = {}, corpo = null, timeoutMs = 240000 }) {
  return new Promise((resolveBruto) => {
    // Resolve uma vez só: timeout, erro de socket e erro no meio do corpo podem
    // disparar juntos. E todo stream tem listener de 'error' (sem ele, um reset da
    // conexão no meio da resposta derrubaria o processo inteiro do Hub).
    let resolvido = false;
    const resolve = (v) => { if (!resolvido) { resolvido = true; resolveBruto(v); } };
    let alvo;
    try { alvo = new URL(urlCompleta); } catch (e) { return resolve({ status: 0, erro: 'url_invalida' }); }
    const cliente = alvo.protocol === 'https:' ? https : http;
    const h = Object.assign({}, headers);
    if (corpo) h['Content-Length'] = Buffer.byteLength(corpo);
    const r = cliente.request({
      hostname: alvo.hostname,
      port: alvo.port || (alvo.protocol === 'https:' ? 443 : 80),
      path: alvo.pathname + alvo.search,
      method,
      headers: h,
    }, (resp) => {
      const partes = [];
      resp.on('data', (c) => partes.push(c));
      resp.on('error', () => resolve({ status: 0, erro: 'resposta_interrompida' }));
      resp.on('aborted', () => resolve({ status: 0, erro: 'resposta_interrompida' }));
      resp.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* corpo não JSON */ }
        resolve({ status: resp.statusCode, json, texto });
      });
    });
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ status: 504, erro: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, erro: e.code || 'erro_rede' }));
    if (corpo) r.write(corpo);
    r.end();
  });
}

function detalheDoErro(resp) {
  const det = resp && resp.json && (resp.json.detail || resp.json);
  if (det && typeof det.detalhe === 'string') return det.detalhe;
  if (det && typeof det === 'string') return det;
  return null;
}

// ── Curadoria pelo Claude ────────────────────────────────────────────────
function mesesComLancamento(serie) {
  return Array.isArray(serie) ? serie.filter((v) => Math.abs(Number(v) || 0) > 0.004).length : null;
}

function entradaParaIA(dados, observacoes) {
  const categorias = (dados.categorias || []).map((c) => ({
    nome: c.nome,
    total: c.total,
    rubricas: (c.rubricas || []).map((r) => {
      const itens = Array.isArray(r.itens) ? r.itens : [];
      const enviados = itens.slice(0, MAX_ITENS_PROMPT).map((i) => ({ rotulo: i.rotulo || '', valor: i.valor, qtd: i.qtd || 1 }));
      const resto = itens.slice(MAX_ITENS_PROMPT);
      const o = {
        chave: r.nome,
        nome: r.nome_exibicao || r.nome,
        total: r.total,
        meses_com_lancamento: mesesComLancamento(r.serie),
        conciliada: ['exato', 'resolvido'].includes(r.status),
        itens: enviados,
      };
      if (resto.length) {
        o.itens_omitidos = resto.length;
        o.valor_omitido = Math.round(resto.reduce((s, i) => s + (Number(i.valor) || 0), 0) * 100) / 100;
      }
      return o;
    }),
  }));
  return {
    condominio: dados.condominio,
    periodo: dados.meses_label || dados.periodo,
    meses: (dados.periodo || []).length,
    observacoes_do_usuario: observacoes || null,
    receitas: (dados.receitas || []).map((r) => ({ nome: r.nome, total: r.total })),
    categorias,
  };
}

function extrairJson(texto) {
  if (!texto) return null;
  const limpo = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const ini = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try { return JSON.parse(limpo.slice(ini, fim + 1)); } catch (e) { return null; }
}

const RE_REAIS = /R\$\s?(\d{1,3}(?:\.\d{3})*,\d{2})/g;
const centavos = (v) => Math.round(Number(v) * 100);

function valoresCitados(texto) {
  const vals = [];
  let m;
  RE_REAIS.lastIndex = 0;
  while ((m = RE_REAIS.exec(texto)) !== null) vals.push(centavos(m[1].replace(/\./g, '').replace(',', '.')));
  return vals; // em centavos
}

// Hífen e travessão usados como pontuação viram vírgula (regra do padrão de escrita).
function semTravessao(s) {
  return String(s).replace(/\s+[-–—]\s+/g, ', ').replace(/[–—]/g, ', ').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
}

// Somas de subconjuntos dos itens de uma rubrica (a curadoria junta parcelas e
// descrições iguais somando os valores). Limitado para não explodir: passou do
// teto, aceita qualquer valor até o total da rubrica.
function somasPossiveis(valores, teto) {
  let somas = new Set([0]);
  for (const v of valores) {
    const novas = new Set(somas);
    for (const s of somas) novas.add(s + v);
    somas = novas;
    if (somas.size > 20000) return null;
  }
  somas.delete(0);
  return somas;
}

// Valores que podem aparecer nos textos gerais (notas de categoria, frase da
// receita): totais, itens, saldos e somas de duas receitas ("água e gás somam").
function valoresGerais(dados) {
  const ok = new Set();
  const add = (v) => { if (v != null && isFinite(Number(v))) ok.add(centavos(v)); };
  add(dados.saldo_anterior); add(dados.saldo_final);
  const rec = (dados.receitas || []).map((r) => centavos(r.total));
  rec.forEach((v) => ok.add(v));
  for (let i = 0; i < rec.length; i++) for (let j = i + 1; j < rec.length; j++) ok.add(rec[i] + rec[j]);
  ok.add(rec.reduce((s, v) => s + v, 0));
  (dados.categorias || []).forEach((c) => {
    add(c.total);
    (c.rubricas || []).forEach((r) => { add(r.total); (r.itens || []).forEach((i) => add(i.valor)); });
  });
  return ok;
}

// Confere a curadoria antes de mandar para o montador. Número nenhum pode vir da
// IA: todo "R$" citado tem que existir nos dados (item, total, soma de itens da
// rubrica). Texto com valor que não existe, longo demais ou vazio sai, e aquela
// rubrica (ou nota) cai no texto automático. "fecha" só fica true se a soma
// citada bate com o total. Assim um deslize numa rubrica não derruba o resto.
function sanearComposicao(comp, dados) {
  if (!comp || typeof comp !== 'object') return null;
  const porChave = {};
  (dados.categorias || []).forEach((c) => (c.rubricas || []).forEach((r) => { porChave[r.nome] = r; }));
  const gerais = valoresGerais(dados);
  const rubricas = {};
  let descartadas = 0;

  Object.entries(comp.rubricas || {}).forEach(([chave, v]) => {
    const r = porChave[chave];
    if (!r || !v || typeof v.texto !== 'string') return;
    const texto = semTravessao(v.texto);
    if (!texto || texto.length > LIMITE_TEXTO) { descartadas++; return; }
    const citados = valoresCitados(texto);
    if (citados.length) {
      const itens = (r.itens || []).map((i) => centavos(i.valor)).filter((x) => x > 0);
      const total = centavos(r.total);
      const somas = somasPossiveis(itens, total);
      const valido = (x) => x === total || itens.includes(x) || (somas ? somas.has(x) : x <= total);
      if (!citados.every(valido)) { descartadas++; return; }
    }
    let fecha = v.fecha === true && ['exato', 'resolvido'].includes(r.status);
    if (fecha) {
      const soma = citados.reduce((s, x) => s + x, 0);
      fecha = citados.length > 0 && Math.abs(soma - centavos(r.total)) <= 2;
    }
    const item = { texto, fecha };
    if (typeof v.nome === 'string') {
      const nome = semTravessao(v.nome);
      if (nome && nome.length <= 80) item.nome = nome;
    }
    rubricas[chave] = item;
  });

  const textoGeralOk = (s, limite) => {
    if (typeof s !== 'string') return null;
    const t = semTravessao(s);
    if (!t || t.length > limite) return null;
    return valoresCitados(t).every((x) => gerais.has(x)) ? t : null;
  };

  const saida = { rubricas };
  const nomesCat = new Set((dados.categorias || []).map((c) => c.nome));
  const categorias = {};
  Object.entries(comp.categorias || {}).forEach(([k, v]) => {
    if (!nomesCat.has(k) || !v || typeof v !== 'object') return;
    const c = {};
    const desc = textoGeralOk(v.desc, 160);
    const nota = textoGeralOk(v.nota, 260);
    if (desc) c.desc = desc;
    if (nota) c.nota = nota;
    if (Object.keys(c).length) categorias[k] = c;
  });
  saida.categorias = categorias;

  // Nome longo quebra linha na tabela de receitas e encavala na de baixo.
  const nomesRec = new Set((dados.receitas || []).map((r) => r.nome));
  const rn = {};
  Object.entries(comp.receitas_nomes || {}).forEach(([k, v]) => {
    if (!nomesRec.has(k) || typeof v !== 'string') return;
    const t = semTravessao(v);
    if (t && t.length <= LIMITE_NOME_RECEITA && !/\d,\d{2}/.test(t)) rn[k] = t;
  });
  saida.receitas_nomes = rn;
  const insight = textoGeralOk(comp.receita_insight, 300);
  if (insight) saida.receita_insight = insight;
  return { comp: saida, descartadas, escritas: Object.keys(rubricas).length };
}

// Divide as categorias em lotes de até RUBRICAS_POR_LOTE rubricas. Uma resposta
// única de condomínio grande (100+ rubricas) passava do teto de saída e vinha
// cortada; em lotes paralelos cada resposta é curta e o total fica mais rápido.
const RUBRICAS_POR_LOTE = 40;
const LOTES_SIMULTANEOS = 3;

function dividirEmLotes(entrada) {
  const lotes = [];
  let atual = { categorias: [], n: 0 };
  for (const c of entrada.categorias) {
    let resto = c.rubricas.slice();
    let primeira = true;
    while (resto.length) {
      const espaco = RUBRICAS_POR_LOTE - atual.n;
      if (espaco <= 0) { lotes.push(atual); atual = { categorias: [], n: 0 }; continue; }
      const parte = resto.slice(0, espaco);
      resto = resto.slice(espaco);
      const cat = { nome: c.nome, total: c.total, rubricas: parte };
      if (primeira) cat.escrever_desc_e_nota = true;
      else cat.continuacao = true;
      atual.categorias.push(cat);
      atual.n += parte.length;
      primeira = false;
    }
  }
  if (atual.n) lotes.push(atual);
  return lotes.map((l, i) => Object.assign({}, entrada, {
    categorias: l.categorias,
    lote: (i + 1) + ' de ' + lotes.length,
    escrever_receitas: i === 0,
    resumo_categorias: entrada.categorias.map((c) => ({ nome: c.nome, total: c.total })),
  }));
}

async function chamarLote(apiKey, lote) {
  const instrucao = lote.escrever_receitas
    ? 'Este lote também traz receitas_nomes (só nomes que precisam de grafia arrumada) e receita_insight.'
    : 'Neste lote NÃO escreva receitas_nomes nem receita_insight.';
  const corpo = JSON.stringify({
    model: MODELO,
    max_tokens: 12000,
    // Prompt de sistema (regras + exemplo do Buritis, uns 8 mil tokens) em cache:
    // os lotes que começam depois do primeiro leem do cache a 10% do preço.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: 'Lote ' + lote.lote + ' da prestação. Escreva só as rubricas deste lote. '
        + 'Escreva desc e nota apenas nas categorias marcadas com escrever_desc_e_nota. ' + instrucao
        + '\n\nDados (JSON):\n' + JSON.stringify(lote),
    }],
  });
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const r = await requisitar('https://api.anthropic.com/v1/messages', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      corpo,
      timeoutMs: 240000,
    });
    if ((r.status === 429 || r.status === 529) && tentativa === 0) {
      await new Promise((ok) => setTimeout(ok, 20000));
      continue;
    }
    if (r.status !== 200 || !r.json) return { ok: false, motivo: 'api_' + (r.status || r.erro) };
    const texto = ((r.json.content || []).find((b) => b.type === 'text') || {}).text || '';
    const comp = extrairJson(texto);
    if (!comp) return { ok: false, motivo: r.json.stop_reason === 'max_tokens' ? 'resposta_cortada' : 'json_invalido', uso: r.json.usage };
    return { ok: true, comp, uso: r.json.usage };
  }
  return { ok: false, motivo: 'api_429' };
}

async function curarComClaude(apiKey, dados, observacoes) {
  const lotes = dividirEmLotes(entradaParaIA(dados, observacoes));
  const resultados = new Array(lotes.length);
  let proximo = 0;
  async function trabalhador() {
    while (proximo < lotes.length) {
      const i = proximo++;
      try { resultados[i] = await chamarLote(apiKey, lotes[i]); } catch (e) { resultados[i] = { ok: false, motivo: 'excecao' }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOTES_SIMULTANEOS, lotes.length) }, trabalhador));

  const comp = { rubricas: {}, categorias: {}, receitas_nomes: {} };
  const uso = { input_tokens: 0, output_tokens: 0 };
  const falhas = [];
  resultados.forEach((r, idx) => {
    if (r && r.uso) {
      uso.input_tokens += (r.uso.input_tokens || 0) + (r.uso.cache_creation_input_tokens || 0) + (r.uso.cache_read_input_tokens || 0);
      uso.cache_lido = (uso.cache_lido || 0) + (r.uso.cache_read_input_tokens || 0);
      uso.output_tokens += r.uso.output_tokens || 0;
    }
    if (!r || !r.ok) { falhas.push(r ? r.motivo : 'sem_resposta'); return; }
    Object.assign(comp.rubricas, r.comp.rubricas || {});
    // desc e nota só valem do lote que tinha o começo da categoria (um lote de
    // continuação não pode sobrescrever a nota escrita no primeiro).
    const donas = new Set(lotes[idx].categorias.filter((c) => c.escrever_desc_e_nota).map((c) => c.nome));
    Object.entries(r.comp.categorias || {}).forEach(([k, v]) => { if (donas.has(k)) comp.categorias[k] = v; });
    if (lotes[idx].escrever_receitas) {
      Object.assign(comp.receitas_nomes, r.comp.receitas_nomes || {});
      if (typeof r.comp.receita_insight === 'string') comp.receita_insight = r.comp.receita_insight;
    }
  });
  if (falhas.length === lotes.length) return { ok: false, motivo: falhas.join(','), uso };
  return { ok: true, comp, uso, lotes: lotes.length, falhas };
}

// ── Registro das rotas ───────────────────────────────────────────────────
module.exports = function registrarPrestacaoV13(app, { requireAuth, ANTHROPIC_KEY, INTERNAL_API_SECRET, PRESTACAO_PDF_API_URL }) {
  const jobs = new Map(); // jobId -> { dono, status, etapa, criadoEm, payload?, erro? }

  const donoDe = (req) => (req.user && req.user.sub) || (req.authMode === 'internal' ? 'internal' : 'anon');

  function agendarLimpeza(jobId) {
    const t = setTimeout(() => jobs.delete(jobId), LIMPEZA_MS);
    if (typeof t.unref === 'function') t.unref();
  }

  async function executar(jobId, { corpo, contentType, nome, observacoes }) {
    const job = jobs.get(jobId);
    const etapa = (e) => { if (job) job.etapa = e; };
    const falhar = (detalhe, erro) => {
      if (job) { job.status = 'error'; job.erro = { erro: erro || 'geracao_falhou', detalhe }; }
      agendarLimpeza(jobId);
    };
    const t0 = Date.now();
    const base = PRESTACAO_PDF_API_URL.replace(/\/+$/, '');

    // 1. Extrair e cruzar os relatórios (código da skill).
    etapa('lendo os relatórios');
    const ext = await requisitar(base + '/v13/extrair', {
      headers: { 'X-Internal-Secret': INTERNAL_API_SECRET, 'Content-Type': contentType },
      corpo,
      timeoutMs: 240000,
    });
    if (ext.status !== 200 || !ext.json || !ext.json.dados) {
      if (ext.status === 422 || ext.status === 413) return falhar(detalheDoErro(ext) || 'Os relatórios não puderam ser lidos.', 'relatorio');
      if (ext.status === 404) return falhar('O serviço de geração deste ambiente ainda está na versão antiga.', 'servico_desatualizado');
      return falhar('O serviço de geração não respondeu. Tente de novo em alguns minutos.', 'servico_indisponivel');
    }
    const { dados, rascunho } = ext.json;

    // 2. Curadoria da composição pelo Claude (só no modo detalhado; o simples não tem itens).
    let composicaoIA = null;
    let uso = null;
    let motivoIA = null;
    let parcialIA = false;
    if (ANTHROPIC_KEY && dados.modo === 'detalhado') {
      etapa('escrevendo a composição de cada despesa');
      try {
        const c = await curarComClaude(ANTHROPIC_KEY, dados, observacoes);
        uso = c.uso || null;
        if (c.ok) {
          const s = sanearComposicao(c.comp, dados);
          composicaoIA = s && s.comp;
          if (s) console.log('[prestacao-v13] curadoria ok lotes=' + c.lotes + ' falhas=' + c.falhas.length
            + ' rubricas=' + s.escritas + ' descartadas=' + s.descartadas);
          if (c.falhas.length) parcialIA = true;
          // Só para teste local: guarda a curadoria para conferência (nunca ligado no Railway).
          if (process.env.PRESTACAO_DEBUG_DIR && composicaoIA) {
            try { fs.writeFileSync(path.join(process.env.PRESTACAO_DEBUG_DIR, 'composicao_ia_' + jobId + '.json'), JSON.stringify(composicaoIA, null, 1)); } catch (e) { /* ignora */ }
          }
        } else {
          motivoIA = c.motivo;
        }
      } catch (e) {
        motivoIA = 'excecao';
      }
      if (motivoIA) console.warn('[prestacao-v13] curadoria falhou motivo=' + motivoIA + '; segue com a automática');
    }

    // 3. Montar, auditar e converter (código da skill).
    etapa('montando a apresentação');
    const mon = await requisitar(base + '/v13/montar', {
      headers: { 'X-Internal-Secret': INTERNAL_API_SECRET, 'Content-Type': 'application/json' },
      corpo: JSON.stringify({ dados, rascunho, nome, composicao_ia: composicaoIA }),
      // montar.py tem teto de 420s e o microserviço pode refazer com a composição
      // automática; espera mais que o pior caso dos dois.
      timeoutMs: 900000,
    });
    if (mon.status !== 200 || !mon.json || !mon.json.pdf_b64) {
      if (mon.status === 422) return falhar(detalheDoErro(mon) || 'A apresentação não passou na conferência.', 'montagem');
      return falhar('O serviço de geração não respondeu na montagem. Tente de novo em alguns minutos.', 'servico_indisponivel');
    }
    const avisos = [];
    if (mon.json.aviso) avisos.push(mon.json.aviso);
    if (motivoIA) avisos.push('A revisão de texto por IA não respondeu; a composição foi montada automaticamente.');
    else if (parcialIA) avisos.push('Parte das despesas ficou com a composição automática (a revisão por IA não respondeu nesse trecho).');
    if (job) {
      job.status = 'done';
      job.payload = {
        pdf_b64: mon.json.pdf_b64,
        pptx_b64: mon.json.pptx_b64,
        nome_arquivo: mon.json.nome_arquivo,
        composicao: mon.json.composicao,
        modo: mon.json.modo,
        resumo: mon.json.resumo,
        avisos,
        duracao_s: Math.round((Date.now() - t0) / 1000),
      };
    }
    console.log('[prestacao-v13] gerado modo=' + mon.json.modo + ' composicao=' + mon.json.composicao
      + ' s=' + Math.round((Date.now() - t0) / 1000)
      + (uso ? ' tokens_in=' + uso.input_tokens + ' cache_lido=' + (uso.cache_lido || 0) + ' tokens_out=' + uso.output_tokens : ''));
    agendarLimpeza(jobId);
  }

  app.post('/api/prestacao/v13/iniciar', requireAuth, (req, res) => {
    if (!INTERNAL_API_SECRET || !PRESTACAO_PDF_API_URL) {
      return res.status(503).json({ erro: 'prestacao_api_nao_configurada' });
    }
    const contentType = req.headers['content-type'] || '';
    if (!/^multipart\/form-data/i.test(contentType)) {
      return res.status(400).json({ erro: 'multipart_obrigatorio' });
    }
    const tamanho = parseInt(req.headers['content-length'] || '0', 10);
    if (!tamanho) return res.status(411).json({ erro: 'content_length_obrigatorio' });
    if (tamanho > TAMANHO_MAX) return res.status(413).json({ erro: 'upload_muito_grande', detalhe: 'Limite: 50MB.' });

    const dono = donoDe(req);
    // Reserva a vaga ANTES de receber o corpo: sem isso, uploads em paralelo do
    // mesmo usuário passavam todos na contagem e cada um segurava até 50MB em memória.
    const ativos = [...jobs.values()].filter((j) => j.status === 'enviando' || j.status === 'processing');
    if (ativos.filter((j) => j.dono === dono).length >= MAX_JOBS_ATIVOS_POR_USUARIO) {
      return res.status(429).json({ erro: 'geracao_em_andamento', detalhe: 'Já existe uma prestação sendo gerada. Aguarde terminar.' });
    }
    if (ativos.length >= MAX_JOBS_ATIVOS_GERAL) {
      return res.status(429).json({ erro: 'servidor_ocupado', detalhe: 'Muitas prestações sendo geradas agora. Tente de novo em alguns minutos.' });
    }
    const jobId = crypto.randomUUID();
    jobs.set(jobId, { dono, status: 'enviando', etapa: 'enviando', criadoEm: Date.now() });
    const liberar = () => jobs.delete(jobId);

    const nome = typeof req.query.nome === 'string' ? req.query.nome.trim().slice(0, 120) : '';
    const observacoes = typeof req.query.obs === 'string' ? req.query.obs.trim().slice(0, 1000) : '';

    const partes = [];
    let recebido = 0;
    let abortado = false;
    req.on('data', (c) => {
      if (abortado) return;
      recebido += c.length;
      if (recebido > TAMANHO_MAX) {
        abortado = true;
        partes.length = 0;
        liberar();
        res.status(413).json({ erro: 'upload_muito_grande', detalhe: 'Limite: 50MB.' });
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('error', () => {
      abortado = true;
      liberar();
      if (!res.headersSent) res.status(400).json({ erro: 'upload_interrompido' });
    });
    req.on('close', () => { if (!abortado && !req.complete) { abortado = true; liberar(); } });
    req.on('end', () => {
      if (abortado) return;
      const job = jobs.get(jobId);
      if (!job) return;
      job.status = 'processing';
      executar(jobId, { corpo: Buffer.concat(partes), contentType, nome: nome || null, observacoes }).catch((e) => {
        const j = jobs.get(jobId);
        if (j && j.status === 'processing') {
          j.status = 'error';
          j.erro = { erro: 'erro_inesperado', detalhe: 'Erro inesperado na geração. Tente de novo.' };
        }
        console.error('[prestacao-v13] erro inesperado:', e && e.message);
        agendarLimpeza(jobId);
      });
      res.status(202).json({ jobId });
    });
  });

  // Sem cache e sem ETag (mesmo motivo da rota de status da ata: 304 sem corpo
  // travava o polling).
  app.get('/api/prestacao/v13/status/:jobId', requireAuth, (req, res) => {
    const enviar = (st, obj) => res.status(st).set('Cache-Control', 'no-store').type('application/json').end(JSON.stringify(obj));
    const j = jobs.get(String(req.params.jobId || ''));
    if (!j || j.dono !== donoDe(req)) return enviar(404, { status: 'not_found' });
    if (j.status === 'done') return enviar(200, Object.assign({ status: 'done' }, j.payload));
    if (j.status === 'error') return enviar(200, Object.assign({ status: 'error' }, j.erro));
    return enviar(200, { status: 'processing', etapa: j.etapa, esperando_s: Math.round((Date.now() - j.criadoEm) / 1000) });
  });
};

// Exportados para teste.
module.exports._interno = { entradaParaIA, sanearComposicao, valoresCitados, extrairJson, semTravessao, dividirEmLotes, SYSTEM_PROMPT };
