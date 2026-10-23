// ─────────────────────────────────────────────────────────────────────────
// T50: certidões negativas do condomínio (Prestação de Contas).
// Uma certidão por tipo e condomínio, guardada no bucket privado "certidoes" em
// <id_superlogica>/<tipo>.pdf e descrita na tabela certidoes_condominio (só o servidor lê e grava).
// O PDF é conferido antes de guardar: texto extraído num processo separado (o mesmo de
// financeiro/entrada.js), tipo reconhecido pelo texto, CNPJ do condomínio presente, situação,
// emissão e validade lidas do texto. Certidão de outro condomínio ou de outro tipo é recusada
// para não ir na prestação errada.
// A busca automática (sites sem verificação de robô) fica em servico/certidoes-busca.js; aqui
// ela é carregada com cuidado: se o arquivo não existir ou falhar, todo tipo vira manual.
// Também gera os alertas do Dashboard (certidão vencendo em até 15 dias ou vencida).
// ─────────────────────────────────────────────────────────────────────────

const path = require('path');

const BUCKET = 'certidoes';
const MAX_PDF = 10 * 1024 * 1024;
const DIAS_AVISO = 15;
const DIA_MS = 86400000;
const INTERVALO_BUSCA_MS = 2 * 60 * 1000;
const URL_MINUTOS = 10;

// Ordem da tela. Municipal ganha nome e link pela cidade do condomínio (ver municipalDe).
const TIPOS = [
  { tipo: 'federal', nome: 'Federal (Receita e PGFN)', link: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj' },
  { tipo: 'estadual', nome: 'Estadual (SEFAZ ES)', link: 'https://s1-internet.sefaz.es.gov.br/certidaonegativa/Gerar' },
  { tipo: 'municipal', nome: 'Municipal', link: null },
  { tipo: 'trabalhista', nome: 'Trabalhista (TST)', link: 'https://cndt-certidao.tst.jus.br/gerarCertidao' },
  { tipo: 'fgts', nome: 'FGTS (Caixa)', link: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf' },
  { tipo: 'falencia', nome: 'Falência e Recuperação (TJES)', link: 'https://sistemas.tjes.jus.br/certidao-negativa/emitir' },
];
const CHAVES = new Set(TIPOS.map((t) => t.tipo));
// Nome curto para o título do alerta ("Certidão FGTS vence em ...").
const NOME_CURTO = { federal: 'Federal', estadual: 'Estadual', municipal: 'Municipal', trabalhista: 'Trabalhista', fgts: 'FGTS', falencia: 'de Falência' };
const MUNICIPIOS = {
  serra: { nome: 'Serra', link: 'https://tributacao.serra.es.gov.br:8080/tbserra/loginWeb.jsp?execobj=ServicosWebSite&tab=tabCertNegCont' },
  vitoria: { nome: 'Vitória', link: 'https://tributario.vitoria.es.gov.br/servicos/CertidaoNegativa/CertidaoNegativa.aspx' },
  'vila velha': { nome: 'Vila Velha', link: 'https://tributacao.vilavelha.es.gov.br/tbw/loginWeb.jsp?execobj=ServicosWebSite&tab=tabCertNegCont' },
  cariacica: { nome: 'Cariacica', link: 'https://sistemas.cariacica.es.gov.br/tbw/loginWeb.jsp?execobj=ServicosWebSite' },
};

const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const pad = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const br = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; };
const diasEntre = (deIso, ateIso) => Math.round((Date.parse(ateIso + 'T00:00:00Z') - Date.parse(deIso + 'T00:00:00Z')) / DIA_MS);
const somarDias = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DIA_MS).toISOString().slice(0, 10);
// Hoje no horário de Brasília (o servidor roda em UTC; depois das 21h já seria amanhã).
function hojeBrasiliaIso() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }

// Texto comparável: sem acento, minúsculas, espaços colapsados. Os sites mudam caixa e
// acentuação entre versões; assim as regras de leitura não quebram por isso.
function normalizar(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// "dd/mm/aaaa" válida -> "aaaa-mm-dd" ou null.
function dataIso(s) {
  const m = String(s || '').match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (d.getUTCFullYear() !== +m[3] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[1] || +m[3] < 2000 || +m[3] > 2100) return null;
  return d.toISOString().slice(0, 10);
}

// Tipo da certidão pelo texto normalizado. Do mais específico para o menos: o texto do TJES e
// o da prefeitura citam "Espírito Santo" e não podem cair em estadual; o federal fala em
// "certidão" e tributos, então FGTS e trabalhista vêm antes.
function identificarTipo(textoNorm) {
  const t = textoNorm;
  if (/certificado de regularidade do fgts|regularidade do fgts/.test(t)) return 'fgts';
  if (/debitos trabalhistas/.test(t)) return 'trabalhista';
  if (/tributos federais/.test(t) && /divida ativa da uniao|certidao/.test(t)) return 'federal';
  if (/tribunal de justica/.test(t) && /falencia|recuperacao judicial/.test(t)) return 'falencia';
  if (/secretaria de estado da fazenda|\bsefaz\b/.test(t) && /espirito santo/.test(t)) return 'estadual';
  if (/prefeitura|municipio/.test(t) && /\bserra\b|\bvitoria\b|\bvila velha\b|\bcariacica\b/.test(t)) return 'municipal';
  return null;
}

// Situação. "Positiva com efeito de negativa" primeiro (contém as duas palavras); no TST o
// título vem como "positiva de débitos trabalhistas com efeito de negativa".
function lerSituacao(textoNorm, tipo) {
  const t = textoNorm;
  if (/positiva\b.{0,80}?com efeitos? de negativa/.test(t)) return 'positiva_com_efeito_negativa';
  if (/certidao positiva/.test(t)) return 'positiva';
  if (/\bnegativa\b|nada consta/.test(t)) return 'negativa';
  // FGTS não fala em negativa: "está REGULAR perante o Fundo de Garantia" (\b evita "irregular").
  if (tipo === 'fgts' && /\bregular\b/.test(t) && !/\birregular\b/.test(t)) return 'negativa';
  return 'desconhecida';
}

const D = '(\\d{1,2}[\\/.]\\d{1,2}[\\/.]\\d{4})';
// Data de emissão: rótulos conhecidos e, por último, a primeira data logo depois de "emiss".
function lerEmissao(textoNorm) {
  const t = textoNorm;
  const res = [
    new RegExp('emitida as \\d{1,2}:\\d{2}(?::\\d{2})? do dia ' + D),
    new RegExp('(?:emitida|expedida)(?: em| no dia)?:? ' + '?' + D),
    new RegExp('data (?:de |da )?emissao:? ?' + D),
    new RegExp('expedicao:? ?' + D), // TST: "Expedição: 22/10/2026, às 10:20:11"
    new RegExp('informacao obtida em:? ?' + D),
    new RegExp('emiss.{0,60}?' + D),
  ];
  for (const re of res) { const m = t.match(re); const iso = m && dataIso(m[1]); if (iso) return iso; }
  // Data por extenso (SEFAZ ES: "certidão emitida ... no dia 23 de outubro de 2026").
  const MESES_EXT = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const ext = t.match(new RegExp('emitida.{0,200}?no dia (\\d{1,2}) de (' + MESES_EXT.join('|') + ') de (\\d{4})'));
  if (ext) { const iso = dataIso(ext[1] + '/' + (MESES_EXT.indexOf(ext[2]) + 1) + '/' + ext[3]); if (iso) return iso; }
  return null;
}

// Validade: "válida até", "validade:", "válido até", intervalo "dd/mm/aaaa a dd/mm/aaaa" (FGTS:
// vale a segunda data) e "válida por N dias" contados da emissão.
function lerValidade(textoNorm, emissao) {
  const t = textoNorm;
  let m = t.match(new RegExp('validade:? ?(?:de )?' + D + ' (?:a|ate) ' + D));
  if (m && dataIso(m[2])) return dataIso(m[2]);
  for (const re of [new RegExp('valid[ao] ate:? ?(?:o dia )?' + D), new RegExp('validade:? ?' + D)]) {
    m = t.match(re);
    if (m && dataIso(m[1])) return dataIso(m[1]);
  }
  m = t.match(/valid[ao] por (\d{1,3}) ?(?:\([a-z ]+\) )?dias|prazo de validade(?: de| e de)? (\d{1,3}) ?(?:\([a-z ]+\) )?dias|validade de (\d{1,3}) ?(?:\([a-z ]+\) )?dias/);
  if (m && emissao) { const n = Number(m[1] || m[2] || m[3]); if (n > 0 && n <= 365) return somarDias(emissao, n); }
  m = t.match(new RegExp(D + ' a ' + D));
  if (m && dataIso(m[1]) && dataIso(m[2]) && dataIso(m[2]) > dataIso(m[1])) return dataIso(m[2]);
  return null;
}

// Validade fora do razoável (antes da emissão ou mais de 2 anos à frente) é leitura errada:
// melhor ficar sem validade (a tela mostra "conferir") do que alertar no dia errado.
function validadeSensata(validade, emissao, hojeIso) {
  if (!validade) return null;
  if (emissao && validade < emissao) return null;
  if (diasEntre(hojeIso, validade) > 730) return null;
  return validade;
}

// O CNPJ pode vir com ou sem pontuação, e às vezes com espaço solto no meio (extração do PDF).
function contemCnpj(texto, cnpj) {
  const c = soDig(cnpj);
  if (c.length !== 14) return false;
  const re = new RegExp('(?<!\\d)' + c.split('').join('[\\s./-]{0,3}') + '(?!\\d)');
  return re.test(String(texto || ''));
}
// A certidão federal de pessoa jurídica pode vir só com a raiz (abrange todos os estabelecimentos).
function contemRaiz(texto, cnpj) {
  const c = soDig(cnpj);
  if (c.length !== 14) return false;
  return new RegExp('(?<!\\d)' + c.slice(0, 2) + '\\.?' + c.slice(2, 5) + '\\.?' + c.slice(5, 8) + '(?![\\d/])').test(String(texto || ''));
}

// Lê tudo o que interessa de um texto de certidão. Função pura (testada em scripts/teste-certidoes.js).
// Devolve { erro, detalhe } ou { tipo, situacao, emitida_em, validade }.
function analisarTexto(texto, { tipoPedido, cnpj, hojeIso, cnpjsDoTexto }) {
  const norm = normalizar(texto);
  const palavras = (norm.match(/[a-z]{3,}/g) || []).length;
  if (palavras < 15) {
    return { erro: 'sem_texto', detalhe: 'Não consegui ler o texto deste PDF (parece escaneado ou foto). Baixe o PDF original direto no site da certidão e envie de novo.' };
  }
  const achado = identificarTipo(norm);
  let tipo;
  if (tipoPedido === 'auto') {
    if (!achado) return { erro: 'tipo_nao_identificado', detalhe: 'Não reconheci qual certidão é esta. Arraste o arquivo no campo da certidão certa.' };
    tipo = achado;
  } else {
    // Sem reconhecer, vale o campo escolhido (site pode ter mudado o texto); reconhecido e
    // diferente do campo, recusa para não guardar a certidão no lugar errado.
    if (achado && achado !== tipoPedido) {
      return { erro: 'tipo_diferente', detalhe: 'Este arquivo parece ser a certidão ' + NOME_CURTO[achado] + ', não a ' + NOME_CURTO[tipoPedido] + '. Confira o campo.' };
    }
    tipo = tipoPedido;
  }
  const c = soDig(cnpj);
  const temNosso = contemCnpj(texto, c) || (tipo === 'federal' && contemRaiz(texto, c));
  if (!temNosso) {
    const outros = (typeof cnpjsDoTexto === 'function' ? cnpjsDoTexto(texto) : []).filter((x) => x.cnpj !== c);
    return {
      erro: 'cnpj_diferente',
      detalhe: outros.length
        ? 'Esta certidão é de outro CNPJ, não do condomínio selecionado. Confira se baixou a certidão do condomínio certo.'
        : 'Não achei o CNPJ do condomínio nesta certidão. Confira se baixou a certidão do condomínio certo.',
    };
  }
  const emitida = lerEmissao(norm);
  const validade = validadeSensata(lerValidade(norm, emitida), emitida, hojeIso);
  return { tipo, situacao: lerSituacao(norm, tipo), emitida_em: emitida, validade };
}

// Municipal pela cidade do cadastro. Fora das quatro cidades, fica sem link (a pessoa emite
// no site da prefeitura dela e arrasta o arquivo).
function municipalDe(cidade) {
  const k = normalizar(cidade);
  const m = MUNICIPIOS[k];
  if (m) return { nome: 'Municipal (' + m.nome + ')', link: m.link };
  return { nome: 'Municipal' + (cidade ? ' (' + String(cidade).trim() + ')' : ''), link: null };
}

// Busca automática do outro módulo. Se não existir ou não carregar, todos os tipos ficam
// manuais e o botão Emitir só abre o site. Carrega a cada uso (require guarda em cache o que
// deu certo; o que falhou é tentado de novo, então o arquivo novo entra sem reiniciar à força).
function carregarBusca() {
  try {
    const b = require(path.join(__dirname, 'certidoes-busca.js'));
    return {
      TIPOS_AUTOMATICOS: b && b.TIPOS_AUTOMATICOS instanceof Set ? b.TIPOS_AUTOMATICOS : new Set(),
      buscar: b && typeof b.buscar === 'function' ? b.buscar : null,
      linkPreenchido: b && typeof b.linkPreenchido === 'function' ? b.linkPreenchido : null,
      // Automática depende da cidade (municipal só em Vitória): usa ehAutomatica quando existe.
      ehAutomatica: b && typeof b.ehAutomatica === 'function' ? b.ehAutomatica : null,
    };
  } catch (e) {
    return { TIPOS_AUTOMATICOS: new Set(), buscar: null, linkPreenchido: null, ehAutomatica: null };
  }
}

// Lista de tipos para a tela, com link (já com o CNPJ quando o site aceita) e se é automática.
function tiposDaTela(busca, cnpj, cidade) {
  return TIPOS.map((t) => {
    let nome = t.nome, link = t.link;
    if (t.tipo === 'municipal') { const m = municipalDe(cidade); nome = m.nome; link = m.link; }
    if (link && busca.linkPreenchido) {
      try { const l = busca.linkPreenchido(t.tipo, soDig(cnpj), cidade); if (typeof l === 'string' && /^https:\/\//.test(l)) link = l; } catch (e) { /* fica o link normal */ }
    }
    return { tipo: t.tipo, nome, link, automatica: busca.ehAutomatica ? !!busca.ehAutomatica(t.tipo, cidade) : busca.TIPOS_AUTOMATICOS.has(t.tipo) };
  });
}

// Nome do arquivo para mostrar na tela: sem pasta, só caracteres comuns, termina em .pdf.
function nomeArquivo(bruto, tipo) {
  let n = String(bruto || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9 _.()À-ÿ-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!/\.pdf$/i.test(n)) n = n ? n.replace(/\.+$/, '') + '.pdf' : '';
  return n.length > 4 ? n : 'Certidao ' + tipo + '.pdf';
}

function criarRotasCertidoes(app, deps) {
  const { requireAuth, express, banco, storageUpload, storageSignedUrl, storageDelete, buscarCadastro, exigirLeituraSuperlogica } = deps;
  const hoje = deps.hoje || hojeBrasiliaIso;
  const busca = () => (deps.busca ? deps.busca() : carregarBusca());
  // Extração de texto injetável (o teste não sobe processo). Padrão: o worker do financeiro,
  // com teto de memória e tempo e sem os segredos do ambiente.
  const extrair = deps.extrairTexto || (async (buf) => { const r = await require('../financeiro/entrada').extrairTexto(buf, 4); return r ? r.texto : null; });
  const cnpjsDoTexto = deps.cnpjsDoTexto || ((t) => require('../financeiro/entrada').cnpjsDoTexto(t));
  const usuario = (req) => { const u = req.user && req.user.sub; return /^[0-9a-f-]{36}$/i.test(String(u || '')) ? u : null; };
  const ultimaBusca = new Map(); // "id:tipo" -> quando começou a última busca

  async function cadastroDe(id) {
    const c = await buscarCadastro(id);
    return { cnpj: (c && c.cnpj) || '', nome: (c && c.nome) || '', cidade: (c && c.endereco && c.endereco.cidade) || '' };
  }

  // Linha do banco -> formato da tela (com link temporário do PDF).
  async function paraTela(l, hojeIso) {
    let url = null;
    if (l.caminho) { try { url = await storageSignedUrl(BUCKET, l.caminho, URL_MINUTOS * 60); } catch (e) { url = null; } }
    return {
      tipo: l.tipo, situacao: l.situacao || 'desconhecida', emitida_em: l.emitida_em || null, validade: l.validade || null,
      arquivo_nome: l.arquivo_nome || null, url, origem: l.origem || null, atualizado_em: l.atualizado_em || null,
      vencida: !!(l.validade && l.validade < hojeIso),
    };
  }

  // Confere e guarda um PDF de certidão. Devolve { status, corpo } para a rota responder.
  async function conferirEGuardar(req, id, tipoPedido, buf, nomeBruto, origem, cad) {
    let texto = null;
    try { texto = await extrair(buf); } catch (e) { texto = null; }
    const a = analisarTexto(texto || '', { tipoPedido, cnpj: cad.cnpj, hojeIso: hoje(), cnpjsDoTexto });
    if (a.erro) return { status: 422, corpo: { erro: a.erro, detalhe: a.detalhe } };
    const caminho = id + '/' + a.tipo + '.pdf';
    await storageUpload(BUCKET, caminho, buf, 'application/pdf'); // x-upsert: substitui a anterior
    const linha = {
      situacao: a.situacao, emitida_em: a.emitida_em, validade: a.validade, arquivo_nome: nomeArquivo(nomeBruto, a.tipo),
      caminho, origem, cnpj: soDig(cad.cnpj), user_id: usuario(req), atualizado_em: new Date().toISOString(),
    };
    // Sem cabeçalho de upsert no helper do banco: tenta atualizar a do mesmo tipo e, se não
    // havia, cria. Corrida entre duas gravações (a segunda criação bate no único) tenta atualizar de novo.
    const filtro = '/rest/v1/certidoes_condominio?id_superlogica=eq.' + id + '&tipo=eq.' + a.tipo;
    let r = await banco('PATCH', filtro, linha);
    if (r.status >= 400) throw new Error('banco_' + r.status);
    if (!Array.isArray(r.body) || !r.body.length) {
      r = await banco('POST', '/rest/v1/certidoes_condominio', { id_superlogica: Number(id), tipo: a.tipo, ...linha });
      if (r.status === 409) r = await banco('PATCH', filtro, linha);
      if (r.status >= 400) throw new Error('banco_' + r.status);
    }
    const gravada = (Array.isArray(r.body) && r.body[0]) || { id_superlogica: Number(id), tipo: a.tipo, ...linha };
    // Uma linha de registro por gravação (sem o CNPJ: só condomínio, tipo, origem e usuário).
    console.log('[certidoes] gravada cond=' + id + ' tipo=' + a.tipo + ' origem=' + origem + ' situacao=' + a.situacao + ' usuario=' + (usuario(req) || 'interno'));
    return { status: 200, corpo: { certidao: await paraTela(gravada, hoje()) } };
  }

  // Lista os tipos (com link e se é automática) e as certidões guardadas do condomínio.
  app.get('/api/certidoes/:idSuperlogica', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica);
    if (!(await exigirLeituraSuperlogica(req, res))) return;
    let cad = { cnpj: '', nome: '', cidade: '' }, aviso;
    try { cad = await cadastroDe(id); } catch (e) {
      console.warn('[certidoes] cadastro ' + id + ' falhou: ' + (e && e.message));
      aviso = 'Não foi possível ler o cadastro do condomínio no Superlógica agora. As certidões guardadas aparecem, mas emitir e enviar novas depende do cadastro.';
    }
    const r = await banco('GET', '/rest/v1/certidoes_condominio?id_superlogica=eq.' + id + '&select=tipo,situacao,emitida_em,validade,arquivo_nome,caminho,origem,atualizado_em&limit=20');
    if (r.status >= 400 || !Array.isArray(r.body)) return res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível ler as certidões guardadas agora.' });
    const h = hoje();
    const certidoes = [];
    for (const l of r.body) if (CHAVES.has(l.tipo)) certidoes.push(await paraTela(l, h));
    const corpo = { cnpj: cad.cnpj || null, nome: cad.nome, cidade: cad.cidade, tipos: tiposDaTela(busca(), cad.cnpj, cad.cidade), certidoes };
    if (aviso) corpo.aviso = aviso;
    res.json(corpo);
  });

  // Envio do PDF pela pessoa. tipo=auto reconhece pelo texto. Corpo cru até 10 MB.
  app.post('/api/certidoes/:idSuperlogica/arquivo', requireAuth, express.raw({ type: '*/*', limit: MAX_PDF }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica);
    const tipoPedido = String(req.query.tipo || 'auto');
    if (tipoPedido !== 'auto' && !CHAVES.has(tipoPedido)) return res.status(400).json({ erro: 'tipo_invalido', detalhe: 'Tipo de certidão inválido.' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ erro: 'arquivo_vazio', detalhe: 'Arquivo vazio.' });
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') return res.status(415).json({ erro: 'formato_invalido', detalhe: 'Envie a certidão em PDF.' });
    if (!(await exigirLeituraSuperlogica(req, res))) return;
    let cad;
    try { cad = await cadastroDe(id); } catch (e) {
      return res.status(502).json({ erro: 'falha_superlogica', detalhe: 'Não foi possível ler o CNPJ do condomínio no Superlógica agora. Tente de novo em alguns minutos.' });
    }
    if (soDig(cad.cnpj).length !== 14) return res.status(422).json({ erro: 'sem_cnpj_cadastro', detalhe: 'O condomínio está sem CNPJ no cadastro do Superlógica. Corrija o cadastro antes de enviar a certidão.' });
    try {
      const r = await conferirEGuardar(req, id, tipoPedido, buf, req.query.nome, 'manual', cad);
      res.status(r.status).json(r.corpo);
    } catch (e) {
      console.warn('[certidoes] gravar ' + id + ' falhou: ' + e.message);
      res.status(503).json({ erro: 'storage', detalhe: 'Não foi possível guardar a certidão agora. Tente de novo.' });
    }
  });

  // Busca automática (só tipos sem verificação de robô). Uma por condomínio e tipo a cada 2 minutos.
  app.post('/api/certidoes/:idSuperlogica/buscar', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica);
    const tipo = String((req.body && req.body.tipo) || '');
    if (!CHAVES.has(tipo)) return res.status(400).json({ erro: 'tipo_invalido', detalhe: 'Tipo de certidão inválido.' });
    const b = busca();
    if (!b.buscar || !b.TIPOS_AUTOMATICOS.has(tipo)) return res.status(409).json({ erro: 'manual', detalhe: 'Esta certidão precisa ser emitida no site. Use o botão Emitir e arraste o PDF aqui.' });
    if (!(await exigirLeituraSuperlogica(req, res))) return;
    const chave = id + ':' + tipo;
    const antes = ultimaBusca.get(chave);
    if (antes && Date.now() - antes < INTERVALO_BUSCA_MS) {
      const seg = Math.ceil((INTERVALO_BUSCA_MS - (Date.now() - antes)) / 1000);
      res.set('Retry-After', String(seg));
      return res.status(429).json({ erro: 'aguarde', detalhe: 'Esta certidão acabou de ser buscada. Tente de novo em ' + seg + ' segundos.' });
    }
    ultimaBusca.set(chave, Date.now());
    if (ultimaBusca.size > 2000) { const corte = Date.now() - INTERVALO_BUSCA_MS; for (const [k, v] of ultimaBusca) if (v < corte) ultimaBusca.delete(k); }
    let cad;
    try { cad = await cadastroDe(id); } catch (e) {
      return res.status(502).json({ erro: 'falhou', detalhe: 'Não foi possível ler o cadastro do condomínio no Superlógica agora.' });
    }
    if (soDig(cad.cnpj).length !== 14) return res.status(422).json({ erro: 'sem_cnpj_cadastro', detalhe: 'O condomínio está sem CNPJ no cadastro do Superlógica.' });
    let achado;
    try {
      achado = await b.buscar(tipo, { cnpj: soDig(cad.cnpj), nome: cad.nome, cidade: cad.cidade });
    } catch (e) {
      console.warn('[certidoes] busca ' + tipo + ' cond=' + id + ' falhou: ' + (e && e.message));
      if (e && e.codigo === 'manual') return res.status(409).json({ erro: 'manual', detalhe: 'O site pediu verificação manual. Use o botão Emitir e arraste o PDF aqui.' });
      return res.status(502).json({ erro: 'falhou', detalhe: 'O site da certidão não respondeu agora. Tente de novo mais tarde ou emita pelo botão Emitir.' });
    }
    const pdf = achado && achado.pdf;
    if (!Buffer.isBuffer(pdf) || pdf.length > MAX_PDF || pdf.slice(0, 4).toString('latin1') !== '%PDF') {
      return res.status(502).json({ erro: 'falhou', detalhe: 'O site não devolveu a certidão em PDF. Emita pelo botão Emitir.' });
    }
    try {
      const r = await conferirEGuardar(req, id, tipo, pdf, achado.nome_arquivo || ('Certidao ' + tipo + '.pdf'), 'automatica', cad);
      // A certidão baixada sozinha não passou na conferência: não é culpa de quem pediu, vira falha da busca.
      if (r.status === 422) return res.status(502).json({ erro: 'falhou', detalhe: 'A certidão baixada do site não passou na conferência (' + r.corpo.erro + '). Emita pelo botão Emitir.' });
      res.status(r.status).json(r.corpo);
    } catch (e) {
      console.warn('[certidoes] gravar ' + id + ' falhou: ' + e.message);
      res.status(503).json({ erro: 'storage', detalhe: 'Não foi possível guardar a certidão agora. Tente de novo.' });
    }
  });

  // Apaga a certidão guardada de um tipo (arquivo e linha).
  app.delete('/api/certidoes/:idSuperlogica/:tipo', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica);
    const tipo = String(req.params.tipo);
    if (!CHAVES.has(tipo)) return res.status(400).json({ erro: 'tipo_invalido', detalhe: 'Tipo de certidão inválido.' });
    if (!(await exigirLeituraSuperlogica(req, res))) return;
    try {
      try { await storageDelete(BUCKET, id + '/' + tipo + '.pdf'); } catch (e) { console.warn('[certidoes] arquivo não apagado: ' + e.message); }
      const r = await banco('DELETE', '/rest/v1/certidoes_condominio?id_superlogica=eq.' + id + '&tipo=eq.' + tipo);
      if (r.status >= 400) throw new Error('banco_' + r.status);
      console.log('[certidoes] apagada cond=' + id + ' tipo=' + tipo + ' usuario=' + (usuario(req) || 'interno'));
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível apagar a certidão agora.' });
    }
  });

  // Certidões dentro da prestação (PDF e PowerPoint). O navegador manda os arquivos da prestação
  // guardada; o servidor junta as certidões válidas deste condomínio (do bucket, não do navegador,
  // para não entrar certidão de outro condomínio) e pede ao prestacao-pdf um slide por certidão
  // no fim de cada arquivo (services/prestacao-pdf/app/certidoes_deck.py).
  const MAX_DECK_B64 = 60 * 1024 * 1024;
  app.post('/api/certidoes/:idSuperlogica/na-prestacao', requireAuth, express.json({ limit: '80mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.idSuperlogica);
    const api = deps.prestacaoPdf || {};
    if (!api.url || !api.segredo) return res.status(503).json({ erro: 'indisponivel', detalhe: 'A montagem da prestação não está configurada neste ambiente.' });
    const corpo = req.body || {};
    const pdf = typeof corpo.pdf_b64 === 'string' ? corpo.pdf_b64 : null;
    const pptx = typeof corpo.pptx_b64 === 'string' ? corpo.pptx_b64 : null;
    if (!pdf && !pptx) return res.status(400).json({ erro: 'sem_arquivos', detalhe: 'Envie o PDF ou o PowerPoint da prestação.' });
    if ((pdf || '').length + (pptx || '').length > MAX_DECK_B64) return res.status(413).json({ erro: 'muito_grande', detalhe: 'A prestação passou do tamanho aceito.' });
    if (!(await exigirLeituraSuperlogica(req, res))) return;
    const r = await banco('GET', '/rest/v1/certidoes_condominio?id_superlogica=eq.' + id + '&select=tipo,situacao,emitida_em,validade,caminho&limit=20');
    if (r.status >= 400 || !Array.isArray(r.body)) return res.status(503).json({ erro: 'banco', detalhe: 'Não foi possível ler as certidões guardadas agora.' });
    const h = hoje();
    let cidade = '';
    const validas = r.body.filter((l) => CHAVES.has(l.tipo) && l.caminho && !(l.validade && l.validade < h));
    if (!validas.length) return res.status(422).json({ erro: 'sem_certidoes', detalhe: 'Este condomínio não tem certidão válida guardada.' });
    if (validas.some((l) => l.tipo === 'municipal')) { try { cidade = (await cadastroDe(id)).cidade; } catch (e) { cidade = ''; } }
    const certidoes = [];
    for (const l of validas) {
      try {
        const url = await storageSignedUrl(BUCKET, l.caminho, 120);
        const a = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!a.ok) throw new Error('storage_' + a.status);
        const buf = Buffer.from(await a.arrayBuffer());
        if (buf.slice(0, 4).toString('latin1') !== '%PDF') throw new Error('nao_pdf');
        const nome = l.tipo === 'municipal' ? municipalDe(cidade).nome : (TIPOS.find((t) => t.tipo === l.tipo) || {}).nome;
        certidoes.push({ tipo: l.tipo, nome, situacao: l.situacao || null, emitida_em: l.emitida_em || null, validade: l.validade || null, pdf_b64: buf.toString('base64') });
      } catch (e) {
        console.warn('[certidoes] na-prestacao cond=' + id + ' tipo=' + l.tipo + ' sem arquivo: ' + e.message);
      }
    }
    if (!certidoes.length) return res.status(503).json({ erro: 'storage', detalhe: 'Não foi possível ler os arquivos das certidões agora. Tente de novo.' });
    try {
      const resp = await fetch(new URL('/v13/certidoes', api.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': api.segredo },
        body: JSON.stringify({ pdf_b64: pdf, pptx_b64: pptx, certidoes }), signal: AbortSignal.timeout(240000),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const det = j && j.detail && typeof j.detail === 'object' ? j.detail.detalhe : null;
        return res.status(resp.status === 422 ? 422 : 502).json({ erro: 'montagem', detalhe: det || 'Não foi possível colocar as certidões na prestação agora. Tente de novo.' });
      }
      console.log('[certidoes] na-prestacao cond=' + id + ' certidoes=' + certidoes.length + ' slides=' + j.slides + ' usuario=' + (usuario(req) || 'interno'));
      res.json({ pdf_b64: j.pdf_b64 || null, pptx_b64: j.pptx_b64 || null, slides: j.slides || 0, tipos: certidoes.map((c) => c.tipo) });
    } catch (e) {
      console.warn('[certidoes] na-prestacao cond=' + id + ' falhou: ' + (e && e.message));
      res.status(502).json({ erro: 'montagem', detalhe: 'O serviço que monta a prestação não respondeu. Tente de novo em instantes.' });
    }
  });

  return { ultimaBusca };
}

// Alertas do Dashboard: certidão guardada vencendo em até 15 dias (media) ou vencida (alta).
// Condomínio sem certidão guardada não gera nada. Mesmo formato de servico/regras/alertas-regras.js.
// banco: a função supabaseAdminRequest (ou { banco }). hoje: Date local, como nos outros alertas.
async function gerarAlertasCertidoes(deps, idSL, hoje) {
  const banco = typeof deps === 'function' ? deps : deps.banco;
  const hojeIso = isoLocal(hoje instanceof Date ? hoje : new Date());
  const r = await banco('GET', '/rest/v1/certidoes_condominio?id_superlogica=eq.' + encodeURIComponent(idSL)
    + '&validade=not.is.null&select=tipo,situacao,validade&order=validade.asc&limit=20').catch(() => null);
  // Tabela ainda não criada (migração 022 não aplicada neste banco): sem alerta e sem falha,
  // para o Dashboard não acusar "não foi possível ler" em todo condomínio.
  if (r && (r.status === 404 || (r.body && (r.body.code === '42P01' || r.body.code === 'PGRST205')))) return { alertas: [], falhas: [] };
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return { alertas: [], falhas: ['certidões'] };
  const alertas = [];
  for (const c of r.body) {
    if (!CHAVES.has(c.tipo) || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.validade || ''))) continue;
    const dias = diasEntre(hojeIso, c.validade);
    if (dias > DIAS_AVISO) continue;
    const vencida = dias < 0;
    const nome = NOME_CURTO[c.tipo];
    alertas.push({
      // estado na chave: quem marcou "vencendo" como resolvido volta a ver quando vencer; certidão
      // nova muda a validade e o alerta antigo some sozinho.
      chave: 'certidao:' + c.tipo + ':' + c.validade + ':' + (vencida ? 'vencida' : 'vencendo'),
      tipo: vencida ? 'certidao_vencida' : 'certidao_vencendo',
      titulo: 'Certidão ' + nome + (vencida ? ' venceu em ' : ' vence em ') + br(c.validade),
      detalhe: {
        gravidade: vencida ? 'alta' : 'media', certidao: c.tipo, validade: br(c.validade), dias, situacao: c.situacao || 'desconhecida',
        resumo: (vencida ? 'vencida há ' + Math.abs(dias) + ' dia' + (Math.abs(dias) === 1 ? '' : 's')
          : dias === 0 ? 'vence hoje' : 'faltam ' + dias + ' dia' + (dias === 1 ? '' : 's'))
          + '; emitir a nova certidão na Prestação de Contas',
      },
    });
  }
  return { alertas, falhas: [] };
}

module.exports = {
  criarRotasCertidoes, gerarAlertasCertidoes, analisarTexto, identificarTipo, lerSituacao, lerEmissao, lerValidade,
  normalizar, contemCnpj, municipalDe, tiposDaTela, nomeArquivo, TIPOS, DIAS_AVISO, BUCKET,
};
