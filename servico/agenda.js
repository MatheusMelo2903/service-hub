// ─────────────────────────────────────────────────────────────────────────
// Agenda do mês: regras puras (sem banco, sem rede). Usadas pelas rotas (servico/rotas-agenda.js),
// pelo agendador (servico/agenda-execucao.js) e pelo teste (scripts/teste-agenda.js).
//
// O que mora aqui:
//  . permissões do módulo (agenda: ver e cadastrar; aprovar só GESTOR e GERENTE; Painel da
//    gestão só para o dono ou quem tem o módulo gestao_painel, que só um GESTOR concede);
//  . leitura da planilha (linhas já lidas no navegador) e validação do JSON da leitura de texto,
//    PDF ou foto; reconhecimento do condomínio da base pelo nome;
//  . classificação de cada item de pauta em tipos de trabalho e o período da prestação;
//  . o plano do mês (tarefas com data calculada pela antecedência) e a comparação com o plano
//    que já existe (o que muda volta para aprovação);
//  . a estimativa de custo antes de aprovar e as tendências do Painel da gestão.
// Datas sempre no formato AAAA-MM-DD, contadas no calendário (sem fuso).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fin = require('./apresentacao-financeiro');

const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA_MS = 86400000;
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Antecedências padrão (em dias). A gestão muda na tela (tabela agenda_config).
const CONFIG_PADRAO = {
  prestacao_dias_antes: 7,
  apresentacao_dias_antes: 3,
  pedir_material_dias_antes: 10,
  previsao_dias_antes: 7,
  certidoes_dia_semana: 1, // 1 = segunda da semana anterior à da assembleia
  ata_dias_depois: 1,
};
const LIMITES_CONFIG = {
  prestacao_dias_antes: [1, 30], apresentacao_dias_antes: [1, 20], pedir_material_dias_antes: [2, 40],
  previsao_dias_antes: [1, 30], certidoes_dia_semana: [1, 5], ata_dias_depois: [0, 10],
};

const TIPOS_TAREFA = ['prestacao_contas', 'apresentacao', 'certidoes', 'pedir_material', 'previsao_orcamentaria', 'ata', 'outra'];
// Tarefas que o sistema faz sozinho na data. As outras viram aviso para a equipe.
const AUTOMATICAS = new Set(['prestacao_contas', 'apresentacao', 'certidoes', 'pedir_material']);
// Tarefas que gastam créditos de processamento (entram na estimativa e no limite por hora).
const GERACOES = new Set(['prestacao_contas', 'apresentacao']);
const STATUS = ['agendada', 'pendente_material', 'rodando', 'pronta_conferir', 'conferida', 'erro', 'manual', 'cancelada'];
const ROTULO_STATUS = {
  agendada: 'Agendada', pendente_material: 'Pendente de material', rodando: 'Rodando', pronta_conferir: 'Pronta para conferir',
  conferida: 'Conferida', erro: 'Erro', manual: 'Com a equipe', cancelada: 'Cancelada',
};
const ROTULO_TIPO = {
  prestacao_contas: 'Prestação de contas', apresentacao: 'Apresentação da assembleia', certidoes: 'Dia das certidões',
  pedir_material: 'Pedir material ao síndico', previsao_orcamentaria: 'Previsão orçamentária', ata: 'Ata da assembleia', outra: 'Tarefa',
};
// Tipos de trabalho de cada item de pauta.
const TRABALHOS = ['prestacao_contas', 'eleicao', 'previsao_orcamentaria', 'regimento', 'obra_orcamentos', 'assuntos_gerais', 'outro'];
const ROTULO_TRABALHO = {
  prestacao_contas: 'Prestação de contas', eleicao: 'Eleição', previsao_orcamentaria: 'Previsão orçamentária', regimento: 'Regimento ou convenção',
  obra_orcamentos: 'Obra ou orçamentos', assuntos_gerais: 'Assuntos gerais', outro: 'Outro assunto',
};
// Motivos de trava (pendência ou erro), com o texto da tela.
const MOTIVOS = {
  falta_edital: 'Falta o edital da assembleia',
  falta_orcamentos: 'Faltam os orçamentos ou documentos do síndico',
  condominio_nao_reconhecido: 'Condomínio não reconhecido na base',
  sem_data: 'Assembleia sem data',
  periodo_aberto: 'O período da prestação ainda não fechou',
  superlogica: 'O Superlógica não respondeu',
  geracao: 'A geração não terminou',
  sem_responsavel: 'Sem pessoa responsável para receber o resultado',
  certidoes_faltando: 'Faltam certidões',
  assembleia_passou: 'A assembleia já aconteceu',
  removida_do_plano: 'Saiu do plano',
};

// ── Datas ──
const pad = (n) => String(n).padStart(2, '0');
function dataValida(iso) {
  if (!RE_DATA.test(String(iso || ''))) return false;
  const d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso;
}
function somarDias(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * DIA_MS).toISOString().slice(0, 10); }
function diaSemana(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); } // 0 domingo
function diasEntre(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DIA_MS); }
// Fim de semana: o que é ANTES da assembleia vai para a sexta anterior; o que é depois, para a segunda.
function utilAntes(iso) { const d = diaSemana(iso); return d === 6 ? somarDias(iso, -1) : d === 0 ? somarDias(iso, -2) : iso; }
function utilDepois(iso) { const d = diaSemana(iso); return d === 6 ? somarDias(iso, 2) : d === 0 ? somarDias(iso, 1) : iso; }
function segundaDaSemana(iso) { const d = diaSemana(iso); return somarDias(iso, d === 0 ? -6 : 1 - d); }
function hojeBrasilia(agora) { return new Date((agora || Date.now()) - 3 * 3600000).toISOString().slice(0, 10); }
function horaBrasilia(agora) { return new Date((agora || Date.now()) - 3 * 3600000).getUTCHours(); }
function dataBr(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
function mesRotulo(m) { if (!RE_MES.test(String(m || ''))) return ''; const [y, mm] = m.split('-').map(Number); return MESES[mm - 1] + ' de ' + y; }
function mesAnterior(m, n) { const [y, mm] = m.split('-').map(Number); const t = y * 12 + (mm - 1) - (n == null ? 1 : n); return Math.floor(t / 12) + '-' + pad((t % 12) + 1); }

// ── Permissões ──
function acoesDe(p, m) { const x = p && p.permissoes && p.permissoes[m]; return x && x.visivel === true && Array.isArray(x.acoes) ? x.acoes : null; }
const ehGestao = (p) => !!(p && (p.role === 'GESTOR' || p.role === 'GERENTE'));
function ehDono(p) { const a = p && p.permissoes && p.permissoes.configuracoes; return !!(a && Array.isArray(a.acoes) && a.acoes.includes('auditoria_total')); }
// Ver a Agenda: GESTOR e GERENTE pelo cargo; os outros com o módulo agenda visível. A carteira
// de cada um continua valendo (o servidor filtra pelos condomínios da carteira).
function podeVer(p, interno) { return !!interno || ehGestao(p) || acoesDe(p, 'agenda') !== null; }
// Mandar a agenda, corrigir item e anexar material.
function podeCadastrar(p, interno) { return !!interno || ehGestao(p) || (acoesDe(p, 'agenda') || []).includes('cadastrar'); }
// Aprovar o plano: só GESTOR ou GERENTE.
function podeAprovar(p, interno) { return !!interno || ehGestao(p); }
// Painel da gestão: o dono e quem recebeu o módulo gestao_painel (só um GESTOR concede).
// Não vem com o cargo: outro GESTOR ou GERENTE sem o módulo não vê.
function podeVerGestao(p, interno) { return !!interno || ehDono(p) || (acoesDe(p, 'gestao_painel') || []).includes('ver'); }

// ── Texto ──
function limpar(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Tira hífen e travessão usados como pontuação no texto que vai para a tela.
function semTraco(s) { return String(s || '').replace(/\s+[-–—]+\s+/g, ', ').replace(/[–—]/g, ', ').replace(/,\s*,/g, ','); }

// ── Condomínio pelo nome ──
const PALAVRAS_FORA = new Set(['condominio', 'cond', 'residencial', 'res', 'edificio', 'ed', 'edif', 'do', 'da', 'de', 'dos', 'das', 'e', 'the', 'associacao', 'conjunto', 'parque', 'jardim', 'torre', 'bloco', 'club', 'clube']);
function tokens(n) { return semAcento(n).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && t.length > 1 && !PALAVRAS_FORA.has(t)); }
// Melhor condomínio da base para o nome lido. base: [{ id_superlogica, nome }].
// Devolve { cond, nota, duvida } ou null. duvida: dois candidatos com a mesma nota (a pessoa escolhe).
function reconhecerCondominio(nome, base) {
  const tn = tokens(nome);
  if (!tn.length || !Array.isArray(base)) return null;
  const alvo = semAcento(nome).replace(/[^a-z0-9]/g, '');
  const notas = [];
  for (const c of base) {
    if (!c || !c.nome) continue;
    const tc = tokens(c.nome);
    if (!tc.length) continue;
    if (semAcento(c.nome).replace(/[^a-z0-9]/g, '') === alvo) { notas.push({ c, nota: 1 }); continue; }
    const setC = new Set(tc);
    const comuns = tn.filter((t) => setC.has(t)).length;
    const nota = comuns / Math.max(tn.length, tc.length) * 0.6 + comuns / Math.min(tn.length, tc.length) * 0.4;
    if (comuns) notas.push({ c, nota });
  }
  notas.sort((a, b) => b.nota - a.nota);
  if (!notas.length || notas[0].nota < 0.6) return null;
  const duvida = notas.length > 1 && notas[1].nota >= notas[0].nota - 0.05 && notas[0].nota < 1;
  return { cond: { id_superlogica: Number(notas[0].c.id_superlogica), nome: notas[0].c.nome, id: notas[0].c.id || null }, nota: Math.round(notas[0].nota * 100) / 100, duvida };
}

// ── Tipo da assembleia ──
function tipoAssembleia(v) {
  const t = semAcento(v).replace(/[^a-z]/g, ' ');
  const ago = /\bago\b|\bordinaria/.test(t); const age = /\bage\b|\bextraordinaria/.test(t);
  if (ago && age) return 'AGO_AGE';
  if (ago) return 'AGO';
  if (age) return 'AGE';
  return null;
}

// ── Datas escritas pela equipe ("12/11", "12/11/2026", "2026-11-12", "12 de novembro") ──
function lerData(v, mes) {
  const s = semAcento(v).trim();
  const [ym, mm] = (RE_MES.test(String(mes || '')) ? mes : '2000-01').split('-').map(Number);
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return dataValida(m[0]) ? m[0] : null;
  if ((m = s.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : (Number(m[2]) < mm - 6 ? ym + 1 : ym);
    const iso = y + '-' + pad(m[2]) + '-' + pad(m[1]);
    return dataValida(iso) ? iso : null;
  }
  if ((m = s.match(/\b(\d{1,2})\s*(?:de\s*)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s*(?:de\s*)?(\d{4}))?/))) {
    const mesN = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'].indexOf(m[2]) + 1;
    const iso = (m[3] ? Number(m[3]) : ym) + '-' + pad(mesN) + '-' + pad(m[1]);
    return dataValida(iso) ? iso : null;
  }
  // Data do Excel (número de dias desde 1899-12-30).
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = Math.floor(Number(s)); if (n > 40000 && n < 60000) return new Date(Date.UTC(1899, 11, 30) + n * DIA_MS).toISOString().slice(0, 10); }
  return null;
}
function lerHora(v) {
  const s = semAcento(v).trim();
  let m = s.match(/\b([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)?\b/);
  if (m) return pad(m[1]) + ':' + (m[2] || '00');
  // Hora do Excel (fração do dia).
  if (/^0?\.\d+$/.test(s)) { const min = Math.round(Number(s) * 1440); if (min >= 0 && min < 1440) return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  return null;
}
// Pauta escrita numa célula ou num parágrafo: "1) Prestação; 2) Eleição" ou uma por linha.
function quebrarPauta(v) {
  if (Array.isArray(v)) return v.map((x) => limpar(x, 300)).filter((x) => x.length >= 3).slice(0, 30);
  const s = String(v || '').replace(/\r/g, '');
  let partes = s.split(/\n|;|(?:^|\s)(?=\d{1,2}\s*[).º°-]\s)/).map((x) => x.replace(/^\s*\d{1,2}\s*[).º°-]\s*/, ''));
  partes = partes.map((x) => limpar(x, 300)).filter((x) => x.length >= 3);
  return partes.slice(0, 30);
}

// ── Classificação de cada item de pauta ──
const RE_ASSUNTOS = /assuntos?\s+gerais|o\s+que\s+ocorrer|outros\s+assuntos|informes?\b|palavra\s+livre|interesse\s+geral|assuntos\s+diversos/i;
const RE_PREVISAO = /previs[ãa]o\s+or[çc]ament|or[çc]amento\s+(anual|para\s+(o\s+(ano|exerc[íi]cio)\s*(de\s+)?)?(20\d\d)?|de\s+20\d\d|do\s+exerc)|taxa\s+condominial|reajuste|cota\s+condominial|valor\s+d[ao]\s+(taxa|cota)/i;
const RE_ELEICAO = /elei[çc][ãa]o|eleger|s[íi]ndic[oa]\s+(e|ou)\s+sub|subs[íi]ndic|conselh(o|eiros)\s+(fiscal|consultivo)|mandato|composi[çc][ãa]o\s+d[ao]\s+(conselho|administra)/i;
const RE_REGIMENTO = /regimento|conven[çc][ãa]o|regulamento\s+interno|normas?\s+internas?/i;
const RE_OBRA = /\bobras?\b|reforma|or[çc]amentos?|pintura|impermeabiliza|benfeitoria|manuten[çc][ãa]o|instala[çc][ãa]o|aquisi[çc][ãa]o|contrata[çc][ãa]o|rateio|fundo\s+de\s+reserva|chamada\s+de\s+capital|projeto|troca\s+d[eao]|substitui[çc][ãa]o|melhoria|c[âa]meras?|port[ãa]o|elevador|piscina|cerca|telhado|fachada/i;

// Tipos de trabalho de um item de pauta (em ordem). O primeiro que casa decide quando o assunto
// é ambíguo: "aprovação do orçamento para 2027" é previsão, não obra.
function classificarItemPauta(texto) {
  const t = String(texto || '');
  const tipos = [];
  if (fin.RE_PRESTACAO.test(t)) tipos.push('prestacao_contas');
  if (RE_PREVISAO.test(t)) tipos.push('previsao_orcamentaria');
  if (RE_ELEICAO.test(t)) tipos.push('eleicao');
  if (RE_REGIMENTO.test(t)) tipos.push('regimento');
  if (!tipos.includes('previsao_orcamentaria') && !tipos.includes('prestacao_contas') && RE_OBRA.test(t)) tipos.push('obra_orcamentos');
  if (!tipos.length) tipos.push(RE_ASSUNTOS.test(t) ? 'assuntos_gerais' : 'outro');
  return tipos;
}

// Período da prestação: o que o item diz; sem período no texto, AGO usa o exercício (os 12 meses
// fechados antes do mês da assembleia) e AGE os 3 meses fechados antes. Devolve
// { inicio, fim, fonte, aviso? }.
function periodoPrestacao(textoItem, tipoAss, dataAss) {
  const p = fin.periodoDoTexto(textoItem || '');
  if (p) return { inicio: p.inicio, fim: p.fim, fonte: 'texto' };
  const base = RE_MES.test(String(dataAss || '').slice(0, 7)) ? dataAss.slice(0, 7) : null;
  if (!base) return null;
  const fim = mesAnterior(base, 1);
  if (tipoAss === 'AGO' || tipoAss === 'AGO_AGE') {
    return { inicio: mesAnterior(base, 12), fim, fonte: 'exercicio', aviso: 'A pauta não diz o período; usei o exercício de ' + mesRotulo(mesAnterior(base, 12)) + ' a ' + mesRotulo(fim) + '. Confira.' };
  }
  return { inicio: mesAnterior(base, 3), fim, fonte: 'padrao', aviso: 'A pauta não diz o período; usei os 3 meses antes da assembleia (' + mesRotulo(mesAnterior(base, 3)) + ' a ' + mesRotulo(fim) + '). Confira.' };
}

// Pauta classificada: [{ texto, trabalhos: [...] }].
function classificarPauta(pauta) {
  return (Array.isArray(pauta) ? pauta : []).map((p) => {
    const texto = limpar(typeof p === 'string' ? p : p && p.texto, 300);
    const manual = p && Array.isArray(p.trabalhos) && p.manual === true ? p.trabalhos.filter((x) => TRABALHOS.includes(x)) : null;
    return { texto, trabalhos: manual && manual.length ? manual : classificarItemPauta(texto), manual: !!(manual && manual.length) };
  }).filter((p) => p.texto.length >= 3).slice(0, 30);
}

// O que cada assembleia precisa ter antes de gerar (para a tela e para o agendador).
function dependencias(item) {
  const tr = new Set((item.pauta || []).flatMap((p) => p.trabalhos || []));
  const deps = [];
  if (tr.has('prestacao_contas')) deps.push({ chave: 'certidoes', nome: 'Certidões negativas', de: 'dia das certidões' });
  deps.push({ chave: 'edital', nome: 'Edital da assembleia', de: 'equipe', obrigatorio: true });
  if (tr.has('obra_orcamentos')) deps.push({ chave: 'orcamentos', nome: 'Orçamentos e fotos da obra', de: 'síndico', obrigatorio: true });
  if (tr.has('regimento')) deps.push({ chave: 'minuta', nome: 'Texto proposto do regimento ou convenção', de: 'síndico' });
  if (tr.has('eleicao')) deps.push({ chave: 'candidatos', nome: 'Nomes dos candidatos, se já houver', de: 'síndico' });
  return deps;
}

// ── Leitura da planilha (linhas lidas no navegador pelo leitor de planilhas que o Hub já usa) ──
const CABECALHOS = {
  condominio: /condom|cliente|empreend|residencial|nome/,
  data: /^data|dia\b|^quando/,
  hora: /hora|horario/,
  tipo: /^tipo|natureza|ago|age|assembleia/,
  pauta: /pauta|ordem|assunto|itens|edital/,
  descricao: /tarefa|descri|observ|obs\b/,
};
function lerPlanilha(linhas, mes) {
  const L = (Array.isArray(linhas) ? linhas : []).slice(0, 400).map((l) => (Array.isArray(l) ? l.slice(0, 30).map((c) => (c == null ? '' : String(c).slice(0, 2000))) : []));
  let cab = -1; let mapa = null;
  for (let i = 0; i < Math.min(L.length, 10) && cab < 0; i++) {
    const m = {};
    L[i].forEach((c, j) => {
      const t = semAcento(c).trim();
      if (!t) return;
      for (const [k, re] of Object.entries(CABECALHOS)) { if (m[k] == null && re.test(t)) { m[k] = j; break; } }
    });
    if (m.condominio != null && m.data != null) { cab = i; mapa = m; }
  }
  if (cab < 0) return { itens: [], nao_entendido: ['A planilha precisa das colunas Condomínio e Data na primeira linha.'] };
  const itens = []; const fora = [];
  for (let i = cab + 1; i < L.length; i++) {
    const l = L[i];
    const pega = (k) => (mapa[k] != null ? l[mapa[k]] || '' : '');
    if (!l.some((c) => String(c).trim())) continue;
    const cond = limpar(pega('condominio'), 120);
    const data = lerData(pega('data'), mes);
    if (!cond && !data) { fora.push('Linha ' + (i + 1) + ': sem condomínio e sem data.'); continue; }
    const tipo = tipoAssembleia(pega('tipo')) || tipoAssembleia(pega('pauta'));
    const desc = limpar(pega('descricao'), 300);
    itens.push({
      condominio: cond, data, hora: lerHora(pega('hora')), tipo_assembleia: tipo, tipo_item: tipo || !desc ? 'assembleia' : 'tarefa',
      pauta: quebrarPauta(pega('pauta')), descricao: desc, trecho: limpar(l.join(' | '), 300),
    });
  }
  return { itens, nao_entendido: fora };
}

// ── JSON devolvido pela leitura de texto, PDF ou foto: validado aqui, campo a campo ──
function validarLeitura(j, mes) {
  const saida = { itens: [], nao_entendido: [] };
  if (!j || typeof j !== 'object' || !Array.isArray(j.itens)) return null;
  j.itens.slice(0, 80).forEach((it, i) => {
    if (!it || typeof it !== 'object') return;
    const cond = limpar(it.condominio, 120);
    const data = dataValida(String(it.data || '')) ? String(it.data) : lerData(String(it.data || ''), mes);
    const hora = RE_HORA.test(String(it.hora || '')) ? String(it.hora) : lerHora(String(it.hora || ''));
    const tipoTxt = String(it.tipo || '');
    const tarefa = /tarefa/i.test(tipoTxt);
    const tipo = tarefa ? null : (['AGO', 'AGE', 'AGO_AGE'].includes(tipoTxt) ? tipoTxt : tipoAssembleia(tipoTxt));
    if (!cond && !data) { saida.nao_entendido.push(limpar(it.trecho, 200) || 'Item ' + (i + 1) + ' sem condomínio e sem data.'); return; }
    saida.itens.push({ condominio: cond, data, hora, tipo_assembleia: tipo, tipo_item: tarefa ? 'tarefa' : 'assembleia', pauta: quebrarPauta(it.pauta), descricao: limpar(it.descricao, 300), trecho: limpar(it.trecho, 300) });
  });
  (Array.isArray(j.nao_entendido) ? j.nao_entendido : []).slice(0, 30).forEach((x) => { const s = limpar(x, 200); if (s) saida.nao_entendido.push(s); });
  return saida;
}

// Junta o condomínio da base e o que falta conferir em cada item lido. base: condomínios da carteira.
function prepararItens(lidos, base, mes) {
  return (lidos || []).map((it) => {
    const avisos = [];
    const r = it.condominio ? reconhecerCondominio(it.condominio, base) : null;
    if (!r) avisos.push('Condomínio não reconhecido na base: confira o nome.');
    else if (r.duvida) avisos.push('Nome parecido com mais de um condomínio: confira.');
    if (!it.data) avisos.push('Sem data.');
    else if (it.data.slice(0, 7) !== mes) avisos.push('A data não é de ' + mesRotulo(mes) + '.');
    if (it.tipo_item === 'assembleia' && !it.tipo_assembleia) avisos.push('Não diz se é AGO ou AGE.');
    if (it.tipo_item === 'assembleia' && !(it.pauta || []).length) avisos.push('Sem pauta: anexe o edital.');
    return Object.assign({}, it, {
      id_superlogica: r ? r.cond.id_superlogica : null, condominio_base: r ? r.cond.nome : null,
      pauta: classificarPauta(it.pauta), avisos,
    });
  });
}

// ── Plano do mês ──
function lerConfig(v) {
  const c = Object.assign({}, CONFIG_PADRAO);
  Object.keys(LIMITES_CONFIG).forEach((k) => {
    const n = Number(v && v[k]);
    if (Number.isInteger(n) && n >= LIMITES_CONFIG[k][0] && n <= LIMITES_CONFIG[k][1]) c[k] = n;
  });
  return c;
}
function assinaturaDe(t) { return JSON.stringify([t.tipo, t.data_execucao, t.parametros || {}]); }
// O "conteúdo" da tarefa (sem a data): se mudar depois de pronta, precisa gerar de novo.
function conteudoDe(t) { return JSON.stringify([t.tipo, t.parametros || {}]); }

// Monta as tarefas desejadas para os itens do mês. itens: linhas de agenda_itens (pauta já
// classificada). Devolve [{ chave, tipo, item_id, id_superlogica, titulo, data_execucao, prazo,
// parametros, automatica, avisos }]. As datas não dependem do dia de hoje (senão o plano
// mudaria sozinho todo dia e voltaria para aprovação): data que já passou roda na primeira
// rodada depois de aprovada, e o agendador descarta o que é de antes de uma assembleia que já foi.
function gerarPlano(itens, config) {
  const cfg = lerConfig(config);
  const out = []; const semanas = new Map();
  const naData = (d, apos) => (apos ? utilDepois(d) : utilAntes(d));
  for (const it of itens || []) {
    if (!it || it.cancelado) continue;
    const nome = it.condominio_nome || 'condomínio';
    if (it.tipo_item === 'tarefa') {
      if (!dataValida(it.data)) continue;
      out.push({ chave: it.id + ':outra', tipo: 'outra', item_id: it.id, id_superlogica: it.id_superlogica || null,
        titulo: limpar(it.descricao || 'Tarefa', 160) + ' (' + nome + ')', data_execucao: it.data, prazo: it.data, parametros: {}, automatica: false });
      continue;
    }
    if (!dataValida(it.data)) continue;
    const ass = it.data;
    const pauta = Array.isArray(it.pauta) ? it.pauta : [];
    const tr = new Set(pauta.flatMap((p) => p.trabalhos || []));
    const base = { item_id: it.id, id_superlogica: it.id_superlogica || null };
    if (tr.has('prestacao_contas')) {
      const p = pauta.find((x) => (x.trabalhos || []).includes('prestacao_contas'));
      const per = periodoPrestacao(p && p.texto, it.tipo_assembleia, ass);
      const prazo = naData(somarDias(ass, -cfg.prestacao_dias_antes));
      out.push(Object.assign({ chave: it.id + ':prestacao', tipo: 'prestacao_contas', titulo: 'Prestação de contas ' + nome, data_execucao: prazo, prazo,
        parametros: per ? { inicio: per.inicio, fim: per.fim, fonte: per.fonte } : { sem_periodo: true }, automatica: true, avisos: per && per.aviso ? [per.aviso] : [] }, base));
      // Dia das certidões: um por semana para todas as assembleias da semana.
      const dia = naData(somarDias(segundaDaSemana(ass), -7 + (cfg.certidoes_dia_semana - 1)));
      const g = semanas.get(dia) || { condominios: new Set(), itens: [] };
      if (it.id_superlogica) g.condominios.add(Number(it.id_superlogica));
      g.itens.push(it.id);
      semanas.set(dia, g);
    }
    const temAssunto = [...tr].some((x) => x !== 'assuntos_gerais');
    if (temAssunto) {
      const prazo = naData(somarDias(ass, -cfg.apresentacao_dias_antes));
      out.push(Object.assign({ chave: it.id + ':apresentacao', tipo: 'apresentacao', titulo: 'Apresentação ' + nome, data_execucao: prazo, prazo,
        parametros: { trabalhos: [...tr].sort() }, automatica: true }, base));
    }
    if ((tr.has('obra_orcamentos') || tr.has('regimento') || tr.has('eleicao'))) {
      const d = naData(somarDias(ass, -cfg.pedir_material_dias_antes));
      out.push(Object.assign({ chave: it.id + ':material', tipo: 'pedir_material', titulo: 'Pedir material ao síndico ' + nome, data_execucao: d, prazo: d,
        parametros: { precisa: dependencias(it).filter((x) => x.de === 'síndico').map((x) => x.nome), ate: naData(somarDias(ass, -cfg.apresentacao_dias_antes - 1)) }, automatica: true }, base));
    }
    if (tr.has('previsao_orcamentaria')) {
      const d = naData(somarDias(ass, -cfg.previsao_dias_antes));
      out.push(Object.assign({ chave: it.id + ':previsao', tipo: 'previsao_orcamentaria', titulo: 'Previsão orçamentária ' + nome, data_execucao: d, prazo: d, parametros: {}, automatica: false }, base));
    }
    const dAta = utilDepois(somarDias(ass, cfg.ata_dias_depois));
    out.push(Object.assign({ chave: it.id + ':ata', tipo: 'ata', titulo: 'Ata ' + nome, data_execucao: dAta, prazo: somarDias(dAta, 2), parametros: {}, automatica: false }, base));
  }
  for (const [dia, g] of [...semanas.entries()].sort()) {
    out.push({ chave: 'certidoes:' + dia, tipo: 'certidoes', item_id: null, id_superlogica: null, titulo: 'Dia das certidões ' + dataBr(dia),
      data_execucao: dia, prazo: dia, parametros: { condominios: [...g.condominios].sort((a, b) => a - b), itens: g.itens.slice().sort() }, automatica: true });
  }
  return out.map((t) => Object.assign(t, { assinatura: assinaturaDe(t), avisos: t.avisos || [] }));
}

// Compara o plano desejado com as tarefas gravadas. Mudança em tarefa já aprovada volta para
// aprovação; se mudou o conteúdo de uma já pronta, volta para agendada (gerar de novo).
// Rodando nunca é mexida (a próxima comparação pega). Devolve { criar, atualizar, cancelar }.
function sincronizarPlano(existentes, desejadas) {
  const porChave = new Map((existentes || []).map((t) => [t.chave, t]));
  const criar = []; const atualizar = []; const cancelar = [];
  const vistas = new Set();
  for (const d of desejadas || []) {
    vistas.add(d.chave);
    const e = porChave.get(d.chave);
    const statusInicial = d.automatica ? 'agendada' : 'manual';
    if (!e) { criar.push(Object.assign({}, d, { status: statusInicial, aprovacao: 'pendente' })); continue; }
    if (e.status === 'rodando') continue;
    // Volta só a que saiu do plano antes (não a que o agendador descartou por a assembleia já ter passado).
    if (e.status === 'cancelada' && e.motivo !== 'removida_do_plano') continue;
    if (e.status === 'cancelada') { atualizar.push({ id: e.id, campos: { status: statusInicial, aprovacao: 'pendente', titulo: d.titulo, data_execucao: d.data_execucao, prazo: d.prazo, parametros: d.parametros, assinatura: d.assinatura, versao: (e.versao || 1) + 1, motivo: null, erro: null } }); continue; }
    if (e.assinatura === d.assinatura && e.titulo === d.titulo) continue;
    const campos = { titulo: d.titulo, data_execucao: d.data_execucao, prazo: d.prazo, parametros: d.parametros, assinatura: d.assinatura, versao: (e.versao || 1) + 1 };
    if (e.assinatura !== d.assinatura) { campos.aprovacao = 'pendente'; campos.aprovada_por = null; campos.aprovada_em = null; }
    const mudouConteudo = conteudoDe(e) !== conteudoDe(d);
    if (mudouConteudo && ['pronta_conferir', 'conferida', 'erro'].includes(e.status)) { campos.status = statusInicial; campos.motivo = null; campos.erro = null; }
    atualizar.push({ id: e.id, campos });
  }
  for (const e of existentes || []) {
    if (!vistas.has(e.chave) && !['cancelada', 'rodando', 'conferida'].includes(e.status)) cancelar.push(e.id);
  }
  return { criar, atualizar, cancelar };
}

// Aprovação: devolve os ids que passam a valer (só as pendentes e não canceladas).
function aprovaveis(tarefas, ids) {
  const quer = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  return (tarefas || []).filter((t) => t.aprovacao === 'pendente' && t.status !== 'cancelada' && (!quer || quer.has(t.id))).map((t) => t.id);
}

// ── Custo antes de aprovar ──
function custoUnitario(env) {
  const n = (v, p) => { const x = Number(v); return isFinite(x) && x >= 0 && x < 100 ? x : p; };
  return { prestacao: n(env && env.AGENDA_CUSTO_PRESTACAO_USD, 0.35), apresentacao: n(env && env.AGENDA_CUSTO_APRESENTACAO_USD, 0.3) };
}
function estimarCusto(tarefas, env, maxHora) {
  const u = custoUnitario(env || process.env);
  const ativas = (tarefas || []).filter((t) => t.status !== 'cancelada' && !['pronta_conferir', 'conferida'].includes(t.status));
  const pendentes = ativas.filter((t) => t.aprovacao === 'pendente');
  const contar = (lista) => {
    const prest = lista.filter((t) => t.tipo === 'prestacao_contas').length;
    const apr = lista.filter((t) => t.tipo === 'apresentacao').length;
    return { prestacoes: prest, apresentacoes: apr, geracoes: prest + apr, usd: Math.round((prest * u.prestacao + apr * u.apresentacao) * 100) / 100 };
  };
  const porDia = {};
  ativas.filter((t) => GERACOES.has(t.tipo)).forEach((t) => { porDia[t.data_execucao] = (porDia[t.data_execucao] || 0) + 1; });
  const maiorDia = Math.max(0, ...Object.values(porDia));
  return { plano: contar(ativas), a_aprovar: contar(pendentes), limite_hora: maxHora, maior_dia: maiorDia,
    horas_no_maior_dia: maxHora > 0 ? Math.ceil(maiorDia / maxHora) : null, unitario: u };
}

// ── Painel do mês ──
function painelDoMes(tarefas, itens, hoje) {
  const vivas = (tarefas || []).filter((t) => t.status !== 'cancelada');
  const fimSemana = somarDias(segundaDaSemana(hoje), 6);
  const nomeItem = new Map((itens || []).map((i) => [i.id, i]));
  const linha = (t) => ({ id: t.id, tipo: t.tipo, titulo: t.titulo, data_execucao: t.data_execucao, status: t.status, aprovacao: t.aprovacao,
    motivo: t.motivo || null, motivo_texto: t.motivo ? (MOTIVOS[t.motivo] || t.motivo) : null, erro: t.erro || null,
    assembleia: t.item_id && nomeItem.get(t.item_id) ? nomeItem.get(t.item_id).data : null });
  return {
    prontas: vivas.filter((t) => ['pronta_conferir', 'conferida'].includes(t.status)).map(linha),
    travadas: vivas.filter((t) => ['pendente_material', 'erro'].includes(t.status) || (t.aprovacao === 'pendente' && t.data_execucao <= somarDias(hoje, 2))).map(linha),
    semana: vivas.filter((t) => t.data_execucao >= hoje && t.data_execucao <= fimSemana && !['conferida'].includes(t.status)).map(linha),
    aguardando_aprovacao: vivas.filter((t) => t.aprovacao === 'pendente').length,
  };
}

// Certidões que faltam por condomínio. linhas: certidoes_condominio (tipo, validade).
// tipos: [{ tipo, nome }] na ordem da tela. ate: a certidão precisa valer até esse dia (o da
// assembleia); mesma regra de validade da tela de certidões.
function certidoesFaltando(linhas, tipos, ate) {
  const por = new Map((linhas || []).map((l) => [l.tipo, l]));
  return (tipos || []).filter((t) => { const l = por.get(t.tipo); return !l || !l.caminho || !!(l.validade && l.validade < ate); }).map((t) => t.nome);
}

// ── Tendências do Painel da gestão (meses anteriores) ──
// tarefas e itens: de vários meses. custoPorMes: { 'AAAA-MM': { usd, chamadas } } das funções de
// prestação e apresentação. Devolve uma linha por mês (do mais antigo ao atual).
function tendencias(meses, itens, tarefas, custoPorMes) {
  return meses.map((m) => {
    const it = (itens || []).filter((i) => i.mes === m && !i.cancelado);
    const ts = (tarefas || []).filter((t) => t.mes === m && t.status !== 'cancelada');
    const ger = ts.filter((t) => GERACOES.has(t.tipo));
    const prontas = ger.filter((t) => t.pronta_em);
    const noPrazo = prontas.filter((t) => t.prazo && String(t.pronta_em).length >= 10 && hojeBrasilia(Date.parse(t.pronta_em)) <= t.prazo);
    const travas = {};
    ts.forEach((t) => (Array.isArray(t.travas) ? t.travas : []).forEach((x) => { if (x && x.motivo) travas[x.motivo] = (travas[x.motivo] || 0) + 1; }));
    const maisTravou = Object.entries(travas).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ motivo: k, texto: MOTIVOS[k] || k, vezes: n }));
    const esperas = prontas.map((t) => { const r = t.resultado || {}; return r.material_em && t.pronta_em ? (Date.parse(t.pronta_em) - Date.parse(r.material_em)) / 3600000 : null; }).filter((h) => h != null && h >= 0);
    const c = (custoPorMes || {})[m] || {};
    return {
      mes: m, rotulo: mesRotulo(m),
      assembleias: it.filter((i) => i.tipo_item === 'assembleia').length,
      prestacoes: ts.filter((t) => t.tipo === 'prestacao_contas').length,
      apresentacoes: ts.filter((t) => t.tipo === 'apresentacao').length,
      prontas: prontas.length, no_prazo: noPrazo.length,
      pct_no_prazo: ger.length ? Math.round(noPrazo.length / ger.length * 100) : null,
      mais_travou: maisTravou,
      horas_material_ate_pronto: esperas.length ? Math.round(esperas.reduce((s, h) => s + h, 0) / esperas.length * 10) / 10 : null,
      geracoes: ger.reduce((s, t) => s + (Number(t.tentativas) || 0), 0),
      custo_usd: typeof c.usd === 'number' ? Math.round(c.usd * 100) / 100 : null,
    };
  });
}

module.exports = {
  CONFIG_PADRAO, LIMITES_CONFIG, TIPOS_TAREFA, AUTOMATICAS, GERACOES, STATUS, ROTULO_STATUS, ROTULO_TIPO, TRABALHOS, ROTULO_TRABALHO, MOTIVOS,
  RE_MES, UUID, dataValida, somarDias, diaSemana, diasEntre, utilAntes, utilDepois, segundaDaSemana, hojeBrasilia, horaBrasilia, dataBr, mesRotulo, mesAnterior,
  podeVer, podeCadastrar, podeAprovar, podeVerGestao, ehGestao, ehDono,
  limpar, semTraco, tokens, reconhecerCondominio, tipoAssembleia, lerData, lerHora, quebrarPauta,
  classificarItemPauta, classificarPauta, periodoPrestacao, dependencias,
  lerPlanilha, validarLeitura, prepararItens,
  lerConfig, assinaturaDe, gerarPlano, sincronizarPlano, aprovaveis, custoUnitario, estimarCusto, painelDoMes, certidoesFaltando, tendencias,
};
