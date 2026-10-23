// Teste da leitura nova da Apresentação de assembleia (servico/apresentacao-leitura.js e
// servico/apresentacao-financeiro.js), com Superlógica, motor e processamento dublados:
//   . EMF convertido pelo motor entra na triagem como imagem do documento;
//   . triagem barata em lotes: N imagens geram teto(N/20) chamadas, nunca uma por imagem;
//   . foto ganha legenda; só print (documento), tabela e gráfico vão para a leitura em alta;
//   . item de prestação de contas gera os slides determinísticos logo depois do divisor, com
//     valores que fecham no centavo e a explicação dos negativos no slide do número;
//   . período tirado do item ou, sem ele, os 3 meses fechados antes da assembleia (com aviso);
//   . falha do Superlógica não derruba a geração;
//   . o mesmo vale para o material novo do modo acrescentar.
// Uso: node scripts/teste-apresentacao-leitura.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../servico/apresentacao');
const L = require('../servico/apresentacao-leitura');
const F = require('../servico/apresentacao-financeiro');
const { extrairJson } = require('../servico/modelo');
const modelos = require('../servico/modelos');

let ok = 0, falha = 0;
const escrever = console.log;
const t = (nome, cond) => { if (cond) ok++; else { falha++; escrever('FALHOU: ' + nome); } };
const jpeg = (s) => '/9j/' + Buffer.from('foto ' + s + ' '.repeat(40)).toString('base64').replace(/=+$/, '').slice(0, 60) + 'AAAA';
const hex16 = (i) => (i.toString(16) + 'abcdef0123456789').slice(0, 16).padStart(16, '0');
const cent = (txt) => { const neg = /^\(/.test(txt); const n = Math.round(Number(txt.replace(/[()R$\s.]/g, '').replace(',', '.')) * 100); return neg ? -n : n; };
const semTracoPontuacao = (o) => !/\s[-–—]\s|[–—]/.test(JSON.stringify(o));

// EMF mínimo (cabeçalho de 88 bytes com a assinatura " EMF" e o registro de fim).
function emf(semente) {
  const b = Buffer.alloc(108);
  b.writeUInt32LE(1, 0); b.writeUInt32LE(88, 4); b.write(' EMF', 40, 'latin1'); b.writeUInt32LE(0x10000, 44); b.writeUInt32LE(108, 48); b.writeUInt32LE(2, 52);
  b.writeUInt32LE(semente, 60);
  b.writeUInt32LE(14, 88); b.writeUInt32LE(20, 92); b.writeUInt32LE(0, 96); b.writeUInt32LE(16, 100); b.writeUInt32LE(20, 104);
  return b.toString('base64');
}

// Resumo como o motor devolve (mesma forma do app/apresentacao_financeiro.py).
const RESUMO = {
  condominio: 'Residencial Teste', periodo: ['2026-07', '2026-08', '2026-09'], rotulo_periodo: 'julho a setembro de 2026',
  meses: [
    { chave: '2026-07', rotulo: 'Jul/26', curto: 'jul/26', receitas: 55000.1, despesas: 34500.33, resultado: 20499.77, saldo_fim: 120499.77, explicacao: '' },
    { chave: '2026-08', rotulo: 'Ago/26', curto: 'ago/26', receitas: 55000.1, despesas: 34500.33, resultado: 20499.77, saldo_fim: 140999.54, explicacao: '' },
    { chave: '2026-09', rotulo: 'Set/26', curto: 'set/26', receitas: 55000.1, despesas: 124500.33, resultado: -69500.23, saldo_fim: 71499.31, explicacao: 'Obra fachada (R$ 90 mil)' },
  ],
  saldo_inicial: 100000, saldo_final: 71499.31, receitas: 165000.3, despesas: 193500.99, resultado: -28500.69,
  arrecadacao: [{ nome: 'Taxa condominial', total: 150000.3 }, { nome: 'Fundo de reserva', total: 15000 }],
  categorias: [
    { nome: 'Pessoal', total: 97500.99, rubricas: [{ nome: 'Salarios', total: 90000, serie: [30000, 30000, 30000], explicacao: '' }, { nome: 'INSS', total: 7500.99, serie: [2500.33, 2500.33, 2500.33], explicacao: '' }] },
    { nome: 'Benfeitorias', total: 90000, rubricas: [{ nome: 'Obra fachada', total: 90000, serie: [0, 0, 90000], explicacao: 'Fora da rotina em set/26.' }] },
    { nome: 'Manutencao', total: 6000, rubricas: [{ nome: 'Manutencao elevador', total: 6000, serie: [2000, 2000, 2000], explicacao: '' }] },
  ],
  sinais: { ha_alerta: true, cobertura: 85.3, quedas_arrecadacao: [], caixa_cobriu: true },
  textos: { resumo: 'O déficit veio de despesa fora da rotina: obra fachada (R$ 90 mil, set/26). Sem ela, a receita cobriria 159% das despesas. A diferença foi paga com o saldo que o condomínio já tinha guardado.', caixa: 'Caixa usado para obra fachada' },
};

// ── 1. Período, item e data (sem chamada) ──
const per = (s) => { const p = F.periodoDoTexto(s); return p ? p.inicio + '>' + p.fim : null; };
t('período: julho a setembro de 2026', per('Prestação de contas de julho a setembro de 2026') === '2026-07>2026-09');
t('período: novembro a janeiro vira dois anos', per('Contas de novembro a janeiro de 2026') === '2025-11>2026-01');
t('período: datas completas', per('Demonstrativo do período de 01/04/2026 a 30/06/2026') === '2026-04>2026-06');
t('período: mês/ano', per('Prestação de contas 07/2026 a 09/2026') === '2026-07>2026-09');
t('período: lista de meses', per('Contas dos meses de julho, agosto e setembro de 2026') === '2026-07>2026-09');
t('período: exercício', per('Aprovação das contas do exercício 2025') === '2025-01>2025-12');
t('período: trimestre', per('Prestação de contas do 2º trimestre de 2026') === '2026-04>2026-06');
t('período: sem período', per('Prestação de contas da gestão') === null);
t('item da pauta', F.itemPrestacao(['Eleição de síndico', 'Prestação de contas de julho a setembro de 2026']).numero === 2 && F.itemPrestacao(['Obra']) === null);
t('data da assembleia', JSON.stringify(F.dataAssembleia('Convocamos para a AGE do dia 16/10/2026 às 19h')) === '[2026,10]'
  && JSON.stringify(F.dataAssembleia('a realizar-se no dia 5 de março de 2026, Serra, 01 de fevereiro de 2026')) === '[2026,3]');
{
  const hoje = new Date(Date.UTC(2026, 9, 23));
  const d = F.decidirPeriodo({ numero: 1, texto: 'Prestação de contas' }, 'AGE do dia 16/10/2026', hoje);
  t('sem período: 3 meses fechados antes da assembleia, com aviso', d.inicio === '2026-07' && d.fim === '2026-09' && /não diz o período/.test(d.avisos[0]));
  const d2 = F.decidirPeriodo({ numero: 1, texto: 'Prestação de contas de agosto a outubro de 2026' }, '', hoje);
  t('mês ainda aberto: para no último fechado e avisa', d2.fim === '2026-09' && /ainda não fechou/.test(d2.avisos[0]));
  t('período inteiro no futuro: não puxa', !!F.decidirPeriodo({ numero: 1, texto: 'Contas de novembro de 2026' }, '', hoje).erro);
}

// ── 2. Slides determinísticos ──
const sl = F.montarSlides(RESUMO, 1);
t('slides: painel, colunas, 2 barras, 2 tabelas', sl.map((s) => s.tipo).join() === 'painel,grafico_colunas,barras,barras,tabela,tabela' && sl.every((s) => s.numero === 1));
const painel = sl[0];
const card = (r) => painel.cards.find((c) => c.rotulo === r);
t('painel: 2 a 6 cartões e faixa até 3', painel.cards.length >= 2 && painel.cards.length <= 6 && painel.faixa.length <= 3);
t('painel: saldo inicial + receitas menos despesas = saldo final (centavo)', cent(card('Saldo inicial').valor) + cent(card('Receitas').valor) - cent(card('Despesas').valor) === cent(card('Saldo final').valor));
t('painel: resultado = receitas menos despesas', cent(card('Resultado').valor) === cent(card('Receitas').valor) - cent(card('Despesas').valor));
t('painel: resultado negativo entre parênteses, vermelho, explicado no próprio cartão', card('Resultado').valor === '(R$ 28.500,69)' && card('Resultado').cor === 'vermelho' && /déficit/i.test(card('Resultado').sub) && card('Resultado').sub.length <= 160);
t('painel: queda do caixa em percentual', painel.faixa[0].valor === 'queda de 28,5%');
const colunas = sl[1];
t('colunas: categorias e séries do mesmo tamanho', colunas.categorias.join() === 'Jul/26,Ago/26,Set/26' && colunas.series.every((x) => x.valores.length === 3) && colunas.series[1].valores[2] === 124500.33);
const cSet = colunas.cards.find((c) => c.rotulo === 'Resultado de Set/26');
t('colunas: mês negativo com explicação no cartão do número', cSet && cSet.valor === '(R$ 69.500,23)' && /fachada/i.test(cSet.sub) && cSet.sub.length <= 160 && colunas.cards.length <= 4);
t('barras: arrecadação e categorias com percentual', sl[2].itens.length === 2 && sl[3].itens[0].nome === 'Pessoal' && sl[2].mostrar_percentual && sl[3].mostrar_percentual);
t('barras: despesa fora da rotina explicada na nota', /Obra fachada: fora da rotina em set\/26/.test(sl[3].nota) && sl[3].nota.length <= 160);
const tab = sl[4];
t('tabela: maior categoria, colunas por mês e total que fecha', tab.titulo === 'Pessoal' && tab.colunas.join() === 'Rubrica,Jul/26,Ago/26,Set/26,Total'
  && tab.linhas.length === 2 && cent(tab.total[4]) === tab.linhas.reduce((s, l) => s + cent(l[4]), 0) && tab.linhas.length <= 15);
t('tabela: explicação da rubrica na observação', /Obra fachada: fora da rotina/.test(sl[5].observacao));
t('slides: sem hífen ou travessão como pontuação', semTracoPontuacao(sl));
{
  const r2 = JSON.parse(JSON.stringify(RESUMO));
  r2.saldo_inicial = 1000; r2.saldo_final = 9000.6;
  r2.meses = [{ chave: '2026-07', rotulo: 'Jul/26', receitas: 10000.6, despesas: 2000, resultado: 8000.6, saldo_fim: 9000.6, explicacao: '' }];
  r2.periodo = ['2026-07']; r2.rotulo_periodo = 'julho de 2026';
  const p2 = F.montarSlides(r2, 1)[0];
  t('caixa cresceu mais de 300%: valor em reais', p2.faixa[0].valor === 'R$ 8.000,60 a mais');
  const r3 = JSON.parse(JSON.stringify(RESUMO)); r3.saldo_final = 1;
  let erro = null; try { F.montarSlides(r3, 1); } catch (e) { erro = e.message; }
  t('números que não fecham: não monta', erro === 'numeros_nao_fecham');
}

// ── 3. Conferência dos tipos novos no validarRoteiro e encaixe ──
{
  const v = A.validarRoteiro({ slides: [
    { tipo: 'pauta', itens: ['Prestação de contas'] }, { tipo: 'item', numero: 1, titulo: 'Prestação de contas' },
    painel, colunas, { tipo: 'grafico_colunas', numero: 1, titulo: 'Quebrado', categorias: ['a', 'b'], series: [{ nome: 'x', valores: [1, 'abc'] }] },
    { tipo: 'painel', numero: 1, titulo: 'Vazio', cards: [{ rotulo: 'só um', valor: '1' }] },
  ] }, { fotos: [], documentos: [], pauta: ['Prestação de contas'] });
  const tipos = v.roteiro.slides.map((s) => s.tipo).join();
  t('validarRoteiro: aceita painel e gráfico de colunas', tipos === 'pauta,item,painel,grafico_colunas,tabela');
  t('validarRoteiro: gráfico inválido vira tabela e painel sem cartões sai, com aviso', v.avisos.some((a) => /virou tabela/.test(a)) && v.avisos.some((a) => /sem cartões válidos/.test(a)));
  const avisos = [];
  const enc = F.encaixar({ slides: [
    { tipo: 'capa' }, { tipo: 'pauta', itens: ['Prestação de contas', 'Obra'] }, { tipo: 'item', numero: 1, titulo: 'Prestação de contas' },
    { tipo: 'numeros', numero: 1, titulo: 'Saldos do print', cards: [] }, { tipo: 'topicos', numero: 1, titulo: 'Análise da diretoria', topicos: ['x'] },
    { tipo: 'item', numero: 2, titulo: 'Obra' }, { tipo: 'encerramento' },
  ] }, { numero: 1, slides: sl }, avisos);
  t('encaixe: logo depois do divisor', enc.slides[3].tipo === 'painel' && enc.slides[8].tipo === 'tabela' && enc.slides[9].titulo === 'Análise da diretoria');
  t('encaixe: slide de números feito do print sai, com aviso', !enc.slides.some((s) => s.titulo === 'Saldos do print') && /trocados pelos números do sistema/.test(avisos[0]));
}

// ── 4. Rotas com dublês ──
const guia = path.join(os.tmpdir(), 'guia-apresentacao-leitura-teste.md');
fs.writeFileSync(guia, 'GUIA DE TESTE');
const chamadas = [];
let respostasRoteiro = [];
const chamarModelo = async (o) => {
  chamadas.push(o);
  if (o.system === L.PROMPT_RAPIDA) {
    const textos = o.content.filter((b) => b.type === 'text' && /^IMAGEM \d+/.test(b.text));
    const imagens = textos.map((b, i) => {
      const k = i + 1;
      if (/PRINT/.test(b.text)) return { k, classe: 'documento', legenda: 'print do regimento grifado' };
      if (/TABELA/.test(b.text)) return { k, classe: 'tabela', legenda: 'demonstrativo de receitas' };
      if (/LOGO/.test(b.text)) return { k, classe: 'logo', legenda: 'logo do condomínio' };
      return { k, classe: 'foto', legenda: 'piscina com azulejos soltos ' + k };
    });
    return { ok: true, texto: JSON.stringify({ imagens }) };
  }
  if (o.system === A.PROMPT_TRIAGEM) {
    const qtd = o.content.filter((b) => b.type === 'image').length;
    return { ok: true, texto: JSON.stringify({ imagens: Array.from({ length: qtd }, (_, i) => ({ k: i + 1, tipo: 'informacao', legenda: 'documento lido ' + (i + 1), texto_extra: 'Art. 10 [grifado: proibido som alto]' })) }) };
  }
  const r = respostasRoteiro.shift();
  return r || { ok: false, erro: 'falha' };
};
const motorRecebeu = {};
let converterFalha = false;
const motor = http.createServer((req, res) => {
  let s = ''; req.on('data', (c) => { s += c; });
  req.on('end', () => {
    const corpo = JSON.parse(s);
    (motorRecebeu[req.url] = motorRecebeu[req.url] || []).push(corpo);
    let r;
    if (req.url === '/v13/imagens/converter') {
      r = converterFalha ? { imagens: corpo.imagens.map((x) => ({ id: x.id, ok: false, motivo: 'não converteu' })) }
        : { imagens: corpo.imagens.map((x) => ({ id: x.id, ok: true, b64: jpeg('emf' + x.id), b64_mini: jpeg('emfmini' + x.id), largura: 1600, altura: 900 })) };
    } else if (req.url === '/v13/apresentacao/financeiro') r = RESUMO;
    else if (req.url === '/v13/apresentacao/ler') {
      r = { roteiro: { titulo_arquivo: 'AGE', slides: [
        { tipo: 'capa', assembleia: 'AGE', condominio: 'Teste', data: '16 de outubro de 2026' },
        { tipo: 'pauta', itens: [{ titulo: 'Prestação de contas de julho a setembro de 2026' }, { titulo: 'Reforma da piscina' }] },
        { tipo: 'item', numero: 1, titulo: 'Prestação de contas de julho a setembro de 2026' },
        { tipo: 'item', numero: 2, titulo: 'Reforma da piscina' }, { tipo: 'fotos', numero: 2, titulo: 'Piscina', fotos: [{ id: 'f1' }] },
        { tipo: 'encerramento' }] }, fotos: [{ id: 'f1', b64: jpeg('antiga') }], documentos_paginas: [] };
    } else r = { pptx_b64: 'UEsDBA==', pdf_b64: 'JVBERi0=', slides: 12, avisos: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r));
  });
});

const USUARIO = '11111111-1111-4111-8111-111111111111';
const perfis = { [USUARIO]: { role: 'OPERACIONAL', permissoes: { apresentacao: { visivel: true, acoes: ['ver', 'gerar'] } } } };
const pedidosSL = [];
let slFalha = false;
const app = express();
const requireAuth = (req, res, next) => { req.user = { sub: USUARIO }; next(); };

motor.listen(0, () => {
  A.criarRotasApresentacao(app, {
    requireAuth, express, extrairJson, modelos, chamarModelo,
    perfilDe: async (req) => perfis[req.user.sub] || null,
    podeModulo: (p, m, a) => !!p && (p.role === 'GESTOR' || !!(p.permissoes[m] && p.permissoes[m].visivel && (!a || p.permissoes[m].acoes.includes(a)))),
    auditoria: { evento: () => {} }, dentroDoLimite: () => true,
    condominioDaBase: async (id) => (id === '136' ? { nome: 'Residencial Teste', id: 136 } : null),
    exigirCarteira: async () => true,
    prestacaoPdf: { url: 'http://127.0.0.1:' + motor.address().port, segredo: 'segredo-teste' },
    puxarDadosPrestacao: async (p) => { pedidosSL.push(p); if (slFalha) throw new Error('superlogica_503'); return { inicio: p.inicio, fim: p.fim, balancetes: {} }; },
    podeUsarSuperlogica: async () => true,
    caminhoGuia: guia, agora: () => Date.parse('2026-10-23T15:00:00Z'),
  });
  const logs = [];
  const logOrig = console.log; const warnOrig = console.warn;
  console.log = (s) => logs.push(String(s)); console.warn = () => {};
  const srv = http.createServer(app).listen(0, async () => {
    const porta = srv.address().port;
    const pedir = (metodo, caminho, corpo) => new Promise((resolve) => {
      const dados = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
      const h = {};
      if (dados) Object.assign(h, { 'content-type': 'application/json', 'content-length': dados.length });
      const q = http.request({ port: porta, path: caminho, method: metodo, headers: h }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ st: res.statusCode, j }); });
      });
      if (dados) q.write(dados); q.end();
    });
    const esperar = async (jobId) => {
      for (let i = 0; i < 300; i++) {
        const r = await pedir('GET', '/api/apresentacao/status/' + jobId);
        if (r.j && r.j.status !== 'processing') return r;
        await new Promise((ok) => setTimeout(ok, 15));
      }
      return null;
    };
    const EDITAL = 'EDITAL DE CONVOCAÇÃO. AGE do dia 16/10/2026, às 19h30. ORDEM DO DIA: 1) Prestação de contas de julho a setembro de 2026; 2) Reforma da piscina; 3) Assuntos gerais. Serra/ES, 01 de outubro de 2026.';
    const ROTEIRO = JSON.stringify({ titulo_arquivo: 'AGE 16.10.2026', slides: [
      { tipo: 'capa', assembleia: 'AGE', condominio: 'Teste', data: '16 de outubro de 2026' },
      { tipo: 'pauta', itens: ['Prestação de contas de julho a setembro de 2026', 'Reforma da piscina', { titulo: 'Assuntos gerais', etiqueta: 'ABERTO' }] },
      { tipo: 'item', numero: 1, titulo: 'Prestação de contas de julho a setembro de 2026' },
      { tipo: 'numeros', numero: 1, titulo: 'Saldos', cards: [{ rotulo: 'Saldo', valor: 'R$ 1,00' }, { rotulo: 'Outro', valor: 'R$ 2,00' }] },
      { tipo: 'topicos', numero: 1, titulo: 'Análise da diretoria', topicos: ['Conforme análise da diretoria'] },
      { tipo: 'item', numero: 2, titulo: 'Reforma da piscina' }, { tipo: 'fotos', numero: 2, titulo: 'Piscina', fotos: [{ id: 'f2' }] },
      { tipo: 'item', numero: 3, titulo: 'Assuntos gerais' }, { tipo: 'encerramento' },
    ] });
    // 45 imagens de PowerPoint com miniatura (1 print, 1 tabela, 1 logo, 42 fotos), 1 EMF e 1 foto enviada sem legenda.
    const textoPptx = '[slide 1] PRINT regimento interno\n[slide 2] TABELA demonstrativo\n[slide 3] LOGO\n[slide 4] Fotos da piscina com texto suficiente\n[slide 5] TABELA da prestação em imagem do Windows';
    const imagens = Array.from({ length: 45 }, (_, i) => ({ doc: 0, pagina: i < 3 ? i + 1 : 4, largura: 1200, altura: 900, area: i < 3 ? 0.1 : 0.15, hash: hex16(i + 1), b64: jpeg('img' + i), b64_mini: jpeg('mini' + i) }));
    const base = () => ({
      idSuperlogica: '136', pedido: 'Monte a AGE', edital_texto: EDITAL,
      documentos: [{ nome: 'Material.pptx', tipo: 'pptx', paginas: 5, texto: textoPptx }],
      fotos: [{ nome: 'IMG_9.jpg', legenda: '', b64: jpeg('enviada'), b64_mini: jpeg('enviadamini') }],
      imagens_documentos: imagens.map((x) => Object.assign({}, x)),
      imagens_vetoriais: [{ doc: 0, pagina: 5, formato: 'emf', b64: emf(1), area: 0.6 }],
    });
    try {
      // Validação do campo novo
      const vRuim = A.validarPedido(Object.assign(base(), { imagens_vetoriais: [{ doc: 0, pagina: 5, formato: 'emf', b64: jpeg('x') }] }));
      t('EMF falso: 400', vRuim.erro && vRuim.erro.status === 400);
      const vMuitos = A.validarPedido(Object.assign(base(), { imagens_vetoriais: Array.from({ length: 22 }, (_, i) => ({ doc: 0, pagina: 5, formato: 'emf', b64: emf(i + 10) })) }));
      t('mais de 20 EMF: ficam 20 e aviso', vMuitos.dados.vetoriais.length === 20 && vMuitos.dados.avisos.some((a) => /limite de 20/.test(a)));

      // Geração completa
      chamadas.length = 0;
      respostasRoteiro = [{ ok: true, texto: ROTEIRO }];
      const g = await pedir('POST', '/api/apresentacao/gerar', base());
      const fim = await esperar(g.j.jobId);
      t('gerar: terminou', fim && fim.j.status === 'done');
      const conv = motorRecebeu['/v13/imagens/converter'] || [];
      t('EMF: uma conversão no motor com o arquivo cru', conv.length === 1 && conv[0].imagens.length === 1 && conv[0].imagens[0].formato === 'emf');
      const rapidas = chamadas.filter((c) => c.system === L.PROMPT_RAPIDA);
      const altas = chamadas.filter((c) => c.system === A.PROMPT_TRIAGEM);
      const nRapidas = rapidas.reduce((s, c) => s + c.content.filter((b) => b.type === 'image').length, 0);
      t('triagem barata: 47 imagens (45 + EMF + foto sem legenda) em teto(47/20) = 3 chamadas', nRapidas === 47 && rapidas.length === Math.ceil(47 / 20));
      t('triagem barata: modelo barato e miniaturas', rapidas.every((c) => c.modelo === modelos.PADRAO.apresentacao_imagens) && rapidas[0].content.some((b) => b.type === 'image' && b.source.data === jpeg('mini0')));
      t('EMF convertido entra na triagem', rapidas.some((c) => c.content.some((b) => b.type === 'image' && b.source.data === jpeg('emfminiv0'))));
      const imgsAlta = altas.flatMap((c) => c.content.filter((b) => b.type === 'image').map((b) => b.source.data));
      t('leitura em alta: só print, tabela e a tabela do EMF (uma chamada)', altas.length === 1 && imgsAlta.length === 3 && imgsAlta.includes(jpeg('img0')) && imgsAlta.includes(jpeg('img1')) && imgsAlta.includes(jpeg('emfv0')));
      escrever('  chamadas de imagem nesta geração: ' + rapidas.length + ' baratas (miniaturas) + ' + altas.length + ' de leitura em alta, para 47 imagens');
      const pri = chamadas.find((c) => c.funcao === 'apresentacao').content;
      t('foto ganha legenda da triagem', /f\d+: imagem do documento d1, slide 4 \| legenda: piscina com azulejos soltos/.test(pri));
      t('foto enviada sem legenda ganha legenda', /f1: arquivo IMG_9\.jpg \| legenda: piscina com azulejos soltos/.test(pri));
      t('logo sai das fotos disponíveis', !/logo do condomínio/.test(pri));
      t('texto do print lido entra no documento', pri.includes('[da imagem do slide 1] Art. 10 [grifado: proibido som alto]'));
      t('texto da tabela do EMF entra no slide 5', pri.includes('[da imagem do slide 5]'));
      t('planejamento recebe a instrução da prestação', pri.includes('NÃO crie slides de números') && pri.includes('saldo inicial R$ 100.000,00'));
      t('Superlógica: período do item', pedidosSL.length === 1 && pedidosSL[0].inicio === '2026-07' && pedidosSL[0].fim === '2026-09' && pedidosSL[0].idCondominio === 136);
      const fin = motorRecebeu['/v13/apresentacao/financeiro'] || [];
      t('motor: resumo financeiro pedido com os dados brutos', fin.length === 1 && fin[0].inicio === '2026-07');
      const rot = motorRecebeu['/v13/apresentacao'][0].roteiro.slides;
      const iDiv = rot.findIndex((s) => s.tipo === 'item' && s.numero === 1);
      t('roteiro: slides financeiros logo depois do divisor do item 1', rot.slice(iDiv + 1, iDiv + 7).map((s) => s.tipo).join() === 'painel,grafico_colunas,barras,barras,tabela,tabela');
      t('roteiro: números do print saem, análise da diretoria fica', !rot.some((s) => s.titulo === 'Saldos') && rot.some((s) => s.titulo === 'Análise da diretoria'));
      const p = rot[iDiv + 1];
      const c = (r) => cent(p.cards.find((x) => x.rotulo === r).valor);
      t('roteiro: valores fecham no centavo', c('Saldo inicial') + c('Receitas') - c('Despesas') === c('Saldo final'));
      t('roteiro: explicação do negativo no slide do número', /déficit/i.test(p.cards.find((x) => x.rotulo === 'Resultado').sub));
      t('roteiro: foto convertida do EMF tem id novo', fim.j.imagens.some((x) => x.vetor === 0 && /^f\d+$/.test(x.id) && x.triagem && x.triagem.tipo === 'informacao'));
      t('log: chamadas de imagem e financeiro', logs.some((l) => /imagens_rapidas=47 chamadas_imagens=4 vetoriais=1 financeiro=sistema/.test(l)));

      // Superlógica fora do ar e conversão falhando: geração segue com aviso
      slFalha = true; converterFalha = true; pedidosSL.length = 0;
      respostasRoteiro = [{ ok: true, texto: ROTEIRO }];
      const g2 = await pedir('POST', '/api/apresentacao/gerar', base());
      const f2 = await esperar(g2.j.jobId);
      const rot2 = motorRecebeu['/v13/apresentacao'][1].roteiro.slides;
      t('Superlógica falhou: geração termina', f2.j.status === 'done' && !rot2.some((s) => s.tipo === 'painel'));
      t('Superlógica falhou: avisa', f2.j.avisos.some((a) => /Superlógica não respondeu/.test(a) && /seguiu com o material enviado/.test(a)));
      t('EMF que não converteu: aviso', f2.j.avisos.some((a) => /não conseguiu abrir ficaram de fora/.test(a)));
      slFalha = false; converterFalha = false;

      // Sem período no item: 3 meses fechados antes da assembleia
      pedidosSL.length = 0;
      respostasRoteiro = [{ ok: true, texto: ROTEIRO }];
      const semPer = Object.assign(base(), { edital_texto: EDITAL.replace('Prestação de contas de julho a setembro de 2026', 'Prestação de contas'), imagens_documentos: [], imagens_vetoriais: [] });
      const f3 = await esperar((await pedir('POST', '/api/apresentacao/gerar', semPer)).j.jobId);
      t('sem período: usa jul a set de 2026 e avisa', pedidosSL[0] && pedidosSL[0].inicio === '2026-07' && pedidosSL[0].fim === '2026-09' && f3.j.avisos.some((a) => /não diz o período/.test(a)));

      // Sem condomínio: avisa e não puxa
      pedidosSL.length = 0;
      respostasRoteiro = [{ ok: true, texto: ROTEIRO }];
      const semCond = Object.assign(base(), { idSuperlogica: undefined, imagens_documentos: [], imagens_vetoriais: [] });
      const f4 = await esperar((await pedir('POST', '/api/apresentacao/gerar', semCond)).j.jobId);
      t('sem condomínio: não puxa e avisa', !pedidosSL.length && f4.j.avisos.some((a) => /Escolha o condomínio/.test(a)));

      // Modo acrescentar: material novo com EMF e miniaturas; item 1 da apresentação pronta só tinha o divisor
      chamadas.length = 0; pedidosSL.length = 0;
      respostasRoteiro = [{ ok: true, texto: JSON.stringify({ inserir: [{ depois_do_slide: 5, slides: [{ tipo: 'fotos', numero: 2, titulo: 'Fotos novas', fotos: [{ id: 'f2' }, { id: 'f3' }] }] }] }) }];
      const atu = {
        idSuperlogica: '136', pedido: 'Acrescente as fotos', pptx_b64: 'UEsDBA==',
        documentos: [{ nome: 'Novo.pptx', tipo: 'pptx', paginas: 2, texto: '[slide 1] Fotos novas da piscina\n[slide 2] TABELA nova' }],
        fotos: [{ nome: 'nova.jpg', legenda: 'piscina hoje', b64: jpeg('nova'), b64_mini: jpeg('novamini') }],
        imagens_documentos: [{ doc: 0, pagina: 1, largura: 1000, altura: 800, area: 0.1, hash: hex16(900), b64: jpeg('novaimg'), b64_mini: jpeg('novaimgmini') }],
        imagens_vetoriais: [{ doc: 0, pagina: 2, formato: 'emf', b64: emf(77), area: 0.5 }],
      };
      const fa = await esperar((await pedir('POST', '/api/apresentacao/atualizar', atu)).j.jobId);
      t('acrescentar: terminou', fa && fa.j.status === 'done');
      const rapA = chamadas.filter((c) => c.system === L.PROMPT_RAPIDA);
      t('acrescentar: triagem barata do material novo numa chamada (2 imagens; foto com legenda não entra)', rapA.length === 1 && rapA[0].content.filter((b) => b.type === 'image').length === 2);
      t('acrescentar: EMF convertido continua a numeração (f1 antiga, f2 e f3 novas, EMF f4)', fa.j.imagens.some((x) => x.vetor === 0 && x.id === 'f4'));
      const rotA = motorRecebeu['/v13/apresentacao'].slice(-1)[0].roteiro.slides;
      const iA = rotA.findIndex((s) => s.tipo === 'item' && s.numero === 1);
      t('acrescentar: item de prestação que só tinha o divisor ganha os slides do sistema', rotA[iA + 1].tipo === 'painel' && pedidosSL.length === 1 && pedidosSL[0].inicio === '2026-07');
      t('acrescentar: instrução da prestação no pedido do que falta', chamadas.find((c) => c.funcao === 'apresentacao').content.includes('NÃO crie slides de números'));
      t('acrescentar: slides do sistema com o número do item', rotA.slice(iA + 1, iA + 7).every((s) => s.numero === 1));
      t('acrescentar: slides antigos ficam', rotA.some((s) => s.titulo === 'Piscina') && rotA.some((s) => s.titulo === 'Fotos novas'));
    } catch (e) {
      falha++; escrever('ERRO: ' + (e && e.stack));
    } finally {
      console.log = logOrig; console.warn = warnOrig;
      srv.close(); motor.close();
      try { fs.unlinkSync(guia); } catch (e) { /* nada */ }
      console.log(ok + ' ok, ' + falha + ' falha(s)');
      process.exit(falha ? 1 : 0);
    }
  });
});
