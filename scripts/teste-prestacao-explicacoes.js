// Teste da explicação dos números negativos na prestação de contas (prestacao-v13.js).
// Nenhuma chamada sai da máquina: o serviço de texto é um dublê (https.request trocado) e o
// microserviço da prestação é um servidor local falso que guarda o corpo do /v13/montar.
// Cobre: sem alerta não chama; com alerta chama uma vez (com as observações, em paralelo
// aos lotes e com entrada compacta); valor inventado, chave desconhecida, mês ou rubrica
// que não existe e texto que cita a ferramenta são descartados; falha, timeout e exceção
// não derrubam a prestação; comp.explicacoes chega no corpo do /v13/montar.
// Uso: node scripts/teste-prestacao-explicacoes.js   (sai com 1 se algo falhar)
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const express = require('express');
const custo = require('../servico/custo');

let ok = 0, falha = 0;
const escrever = console.log;
const t = (nome, cond) => { if (cond) ok++; else { falha++; escrever('FALHOU: ' + nome); } };

// ── Dublê do serviço de texto ──
const CHAVE = 'chave-de-teste-nao-real';
let pedidos = [];          // { tipo: 'explicacao'|'lote', corpo, respondidosAntes }
let respondidos = 0;
let respostaExp = null;    // função () -> { status, json } | 'timeout' | 'excecao'
const custos = [];
custo.registrar = (info) => { custos.push(info); return true; };

let SYSTEM_EXPLICACOES = null;
https.request = function (opts, cb) {
  const req = new EventEmitter();
  let corpo = '';
  let aoEstourar = null;
  req.setTimeout = (ms, fn) => { aoEstourar = fn; };
  req.write = (c) => { corpo += c; };
  req.destroy = () => {};
  req.end = () => {
    const j = JSON.parse(corpo);
    const ehExp = j.system && j.system[0] && j.system[0].text === SYSTEM_EXPLICACOES;
    pedidos.push({ tipo: ehExp ? 'explicacao' : 'lote', corpo: j, host: opts.hostname, chave: opts.headers && opts.headers['x-api-key'], respondidosAntes: respondidos });
    let r;
    if (ehExp) {
      r = respostaExp ? respostaExp() : { status: 500, json: { erro: 'x' } };
      if (r === 'timeout') return setImmediate(() => aoEstourar && aoEstourar());
    } else {
      r = { status: 200, json: { content: [{ type: 'text', text: '{"rubricas": {}}' }], usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: 'end_turn' } };
    }
    // Lotes demoram um pouco: a explicação tem de sair antes de qualquer lote responder.
    setTimeout(() => {
      respondidos++;
      const resp = new EventEmitter(); resp.statusCode = r.status;
      cb(resp);
      resp.emit('data', Buffer.from(JSON.stringify(r.json))); resp.emit('end');
    }, ehExp ? 5 : 40);
  };
  if (respostaExp && respostaExp.lancar && opts.hostname === 'api.anthropic.com') {
    // Erro de rede síncrono na próxima chamada (usado só no teste direto da explicação).
    respostaExp.lancar = false;
    throw new Error('falha de rede simulada');
  }
  return req;
};

const P = require('../prestacao-v13');
const I = P._interno;
SYSTEM_EXPLICACOES = I.SYSTEM_EXPLICACOES;

// ── Dados de teste ──
const sinaisAlerta = () => ({
  ha_alerta: true, resultado: -141000, cobertura: 81, cobertura_sem_nao_recorrentes: 101.3,
  resultado_sem_nao_recorrentes: 72456.78, saldo_inicial: 250000, saldo_final: 109000, caixa_cobriu: true,
  total_nao_recorrente: 213456.78, total_sazonal: 0,
  grupos: [{
    categoria: 'MANUTENÇÃO', rubrica: 'REFORMA SALÃO', nome: 'Reforma salão', tipo: 'nao_recorrente', periodo: 'abr a jun/26',
    valor: 213456.78, excesso: 213456.78,
    itens: [{ rotulo: 'Medição da obra', valor: 180000 }, { rotulo: 'Armários', valor: 33456.78 }, { rotulo: 'Terceiro', valor: 10 }, { rotulo: 'Quarto', valor: 20 }, { rotulo: 'Quinto', valor: 30 }],
  }],
  meses_negativos: [{ mes: 'abr/26', resultado: -48000, motivos: ['Reforma salão (R$ 80 mil)'] }],
  quedas_arrecadacao: [],
  contas: [
    { nome: 'Fundo de reserva', reserva: true, ini: 234000, fim: 93000, variacao: -141000, saidas: [{ mes: 'abr/26', valor: 100000 }, { mes: 'mai/26', valor: 101000 }], entradas: [], total_saidas: 201000 },
    { nome: 'Conta movimento', reserva: false, ini: 16000, fim: 16000, variacao: 0, saidas: [], entradas: [], total_saidas: 0 },
  ],
  textos: { resumo: 'O déficit veio de despesas fora da rotina: reforma salão (R$ 213 mil, abr a jun/26).' },
});
const dadosBase = (sinais, modo) => ({
  condominio: 'Residencial Teste', periodo: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
  meses_label: 'jan a jun/26', modo: modo || 'detalhado', saldo_anterior: 250000, saldo_final: 109000,
  receitas_mes: [1, 2, 3, 4, 5, 6], despesas_mes: [1, 2, 3, 4, 5, 6],
  receitas: [{ nome: 'Taxa condominial', total: 600000 }],
  categorias: [{ nome: 'MANUTENÇÃO', total: 213456.78, rubricas: [{ nome: 'REFORMA SALÃO', total: 213456.78, status: 'exato', serie: [0, 0, 0, 80000, 80000, 53456.78], itens: [{ rotulo: 'Medição da obra', valor: 180000 }, { rotulo: 'Armários', valor: 33456.78 }] }] }],
  sinais,
});
const OBS = 'A reforma foi aprovada na AGE de março e paga com o fundo de reserva.';
const RESUMO_BOM = 'O déficit veio da reforma do salão de festas, com medições da obra e armários. Saíram R$ 201 mil do fundo de reserva, que foi de R$ 234 mil para R$ 93 mil. Sem a obra, a receita cobriria 101% das despesas.';
const respostaBoa = () => ({
  resumo: RESUMO_BOM,
  caixa: 'Uso planejado do fundo de reserva para a reforma do salão',
  meses: { 'abr/26': 'Medição da reforma do salão de festas', 'dez/25': 'Mês que não existe nos sinais' },
  rubricas: { 'MANUTENÇÃO|REFORMA SALÃO': 'Reforma do salão de festas — medições da obra (R$ 180.000,00) e armários (R$ 33.456,78).', 'OUTRA|RUBRICA': 'Não existe' },
  contas: 'Fundo de reserva: saíram R$ 500 mil em abr/26.',
  extra: 'chave desconhecida',
});
const comoApi = (obj) => () => ({ status: 200, json: { content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 900, output_tokens: 200 }, stop_reason: 'end_turn' } });

// ── 1. Conferência da resposta (sem rede) ──
(function () {
  const s = sinaisAlerta();
  const r = I.sanearExplicacoes(respostaBoa(), s);
  const e = r.exp;
  t('saneamento: resumo com valores em mil e percentual conferidos fica', e.resumo === RESUMO_BOM);
  t('saneamento: caixa fica', e.caixa === 'Uso planejado do fundo de reserva para a reforma do salão');
  t('saneamento: mês que existe fica, mês que não existe sai', e.meses && e.meses['abr/26'] && !('dez/25' in e.meses));
  t('saneamento: rubrica que não existe sai', e.rubricas && !('OUTRA|RUBRICA' in e.rubricas));
  t('saneamento: travessão vira vírgula e valor exato confere', e.rubricas['MANUTENÇÃO|REFORMA SALÃO'] === 'Reforma do salão de festas, medições da obra (R$ 180.000,00) e armários (R$ 33.456,78).');
  t('saneamento: valor inventado descarta o texto', !('contas' in e));
  t('saneamento: chave desconhecida descartada', !('extra' in e) && r.descartadas >= 4);
  const v = (txt, k) => I.sanearExplicacoes({ [k || 'resumo']: txt }, s).exp[k || 'resumo'];
  t('valores: exato com 1 centavo de folga', !!v('Foram R$ 213.456,79 na reforma.') && !v('Foram R$ 213.456,81 na reforma.'));
  t('valores: mil com 1 mil de folga', !!v('Foram R$ 214 mil na reforma.') && !v('Foram R$ 216 mil na reforma.'));
  t('valores: R$ sem número válido descarta', !v('Foram R$ alguns mil na reforma.'));
  t('percentual inventado descarta', !v('A receita cobriu 95% das despesas.') && !!v('A receita cobriu 81% das despesas.'));
  t('texto citando a ferramenta descarta', !v('Texto escrito pela IA sobre a reforma do salão.'));
  t('texto longo corta na última frase que cabe', (() => { const c = v('Uso do fundo de reserva. ' + 'x'.repeat(100), 'caixa'); return c === 'Uso do fundo de reserva.'; })());
  t('texto longo sem frase que caiba sai', !v('y'.repeat(100), 'caixa'));
  t('meses não objeto descartado', !('meses' in I.sanearExplicacoes({ meses: ['abr/26'] }, s).exp));
  t('resposta inválida devolve null', I.sanearExplicacoes(null, s) === null && I.sanearExplicacoes([], s) === null);
  const ent = I.entradaExplicacoes(dadosBase(Object.assign(sinaisAlerta(), { serie_mensal: [1, 2, 3] })), OBS);
  t('entrada: grupos com no máximo 4 itens', ent.sinais.grupos[0].itens.length === 4);
  t('entrada: só contas que mudaram', ent.sinais.contas.length === 1 && ent.sinais.contas[0].nome === 'Fundo de reserva');
  t('entrada: sem série mensal nem categorias', !JSON.stringify(ent).includes('serie') && !('categorias' in ent));
  t('entrada: observações, condomínio e período', ent.observacoes_do_usuario === OBS && ent.condominio === 'Residencial Teste' && ent.periodo === 'jan a jun/26');
  t('entrada: chave da rubrica no formato CATEGORIA|RUBRICA', ent.sinais.grupos[0].chave === 'MANUTENÇÃO|REFORMA SALÃO');
  t('prompt: sem hífen como pontuação', !/\s[-–—]\s/.test(I.SYSTEM_EXPLICACOES));
})();

// ── 2. Rota completa com dublês ──
let dadosDaVez = null;
let montarRecebeu = null;
const motor = http.createServer((req, res) => {
  let s = ''; req.on('data', (c) => { s += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v13/extrair') return res.end(JSON.stringify({ dados: dadosDaVez, rascunho: {} }));
    montarRecebeu = JSON.parse(s);
    res.end(JSON.stringify({ pdf_b64: 'JVBERi0=', pptx_b64: 'UEsDBA==', nome_arquivo: 'teste.pdf', composicao: 'ia', modo: 'detalhado' }));
  });
});

const UID = ['11111111', '2222', '4333', '8444', '555555555555'].join('-');
const app = express();
const requireAuth = (req, res, next) => { req.authMode = 'internal'; req.user = { sub: UID }; next(); };

motor.listen(0, () => {
  P(app, { requireAuth, ANTHROPIC_KEY: CHAVE, INTERNAL_API_SECRET: 'segredo-teste', PRESTACAO_PDF_API_URL: 'http://127.0.0.1:' + motor.address().port });
  const logs = [];
  const logOrig = console.log; const warnOrig = console.warn;
  console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  const srv = http.createServer(app).listen(0, async () => {
    const porta = srv.address().port;
    const pedir = (metodo, caminho, corpo, tipo) => new Promise((resolve) => {
      const h = {};
      if (corpo) Object.assign(h, { 'content-type': tipo, 'content-length': corpo.length });
      const q = http.request({ port: porta, path: caminho, method: metodo, headers: h }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ st: res.statusCode, j }); });
      });
      if (corpo) q.write(corpo); q.end();
    });
    const gerar = async (dados, obs) => {
      dadosDaVez = dados; montarRecebeu = null; pedidos = []; respondidos = 0; custos.length = 0;
      const corpo = Buffer.from('--x\r\nContent-Disposition: form-data; name="inicio"\r\n\r\n2026-01\r\n--x--\r\n');
      const r = await pedir('POST', '/api/prestacao/v13/iniciar?obs=' + encodeURIComponent(obs || ''), corpo, 'multipart/form-data; boundary=x');
      for (let i = 0; i < 300 && r.j && r.j.jobId; i++) {
        const s = await pedir('GET', '/api/prestacao/v13/status/' + r.j.jobId);
        if (s.j && s.j.status !== 'processing') return s.j;
        await new Promise((ok) => setTimeout(ok, 10));
      }
      return null;
    };
    const exps = () => pedidos.filter((p) => p.tipo === 'explicacao');
    try {
      // a. Sem alerta: nenhuma chamada extra e nada muda no corpo.
      respostaExp = comoApi(respostaBoa());
      let fim = await gerar(dadosBase({ ha_alerta: false }), OBS);
      t('sem alerta: prestação gerada', fim && fim.status === 'done');
      t('sem alerta: nenhuma chamada de explicação', exps().length === 0 && pedidos.length === 1);
      t('sem alerta: montar sem explicacoes', montarRecebeu && montarRecebeu.composicao_ia && !('explicacoes' in montarRecebeu.composicao_ia));
      fim = await gerar(dadosBase(undefined), OBS);
      t('sem sinais: nenhuma chamada de explicação', fim && fim.status === 'done' && exps().length === 0);

      // b. Com alerta: uma chamada, com observações, em paralelo, e o resultado no montar.
      respostaExp = comoApi(respostaBoa());
      fim = await gerar(dadosBase(sinaisAlerta()), OBS);
      const ex = exps();
      t('com alerta: prestação gerada', fim && fim.status === 'done');
      t('com alerta: uma chamada de explicação', ex.length === 1);
      const c = ex[0] && ex[0].corpo;
      t('com alerta: observações na entrada', c && c.messages[0].content.includes(OBS));
      t('com alerta: saída curta (1500) e system em cache', c && c.max_tokens === 1500 && c.system[0].cache_control && c.system[0].cache_control.type === 'ephemeral');
      t('com alerta: mesmo modelo dos lotes', c && pedidos.filter((p) => p.tipo === 'lote').every((p) => p.corpo.model === c.model && JSON.stringify(p.corpo.output_config) === JSON.stringify(c.output_config)));
      t('com alerta: sai em paralelo, antes de qualquer lote responder', ex[0] && ex[0].respondidosAntes === 0);
      t('com alerta: chave só no cabeçalho do serviço', ex[0] && ex[0].chave === CHAVE && ex[0].host === 'api.anthropic.com');
      const e = montarRecebeu && montarRecebeu.composicao_ia && montarRecebeu.composicao_ia.explicacoes;
      t('montar: explicacoes chegam no corpo', !!e && e.resumo === RESUMO_BOM && e.caixa && e.meses['abr/26']);
      t('montar: valor inventado e chave desconhecida não chegam', e && !('contas' in e) && !('extra' in e) && !('dez/25' in e.meses));
      t('montar: rubricas da curadoria continuam', montarRecebeu && 'rubricas' in montarRecebeu.composicao_ia);
      t('custo: chamada registrada na função da prestação', custos.filter((x) => x.funcao === 'prestacao').length === pedidos.length && custos.some((x) => x.usage && x.usage.input_tokens === 900));

      // c. Falha da chamada (erro do serviço): segue com o texto padrão.
      respostaExp = () => ({ status: 500, json: { erro: 'interno' } });
      fim = await gerar(dadosBase(sinaisAlerta()), OBS);
      t('falha 500: prestação gerada sem explicacoes', fim && fim.status === 'done' && montarRecebeu && !('explicacoes' in (montarRecebeu.composicao_ia || {})));
      t('falha 500: sem aviso novo para o usuário', fim && !(fim.avisos || []).some((a) => /explica/i.test(a)));

      // d. Timeout.
      respostaExp = () => 'timeout';
      fim = await gerar(dadosBase(sinaisAlerta()), OBS);
      t('timeout: prestação gerada sem explicacoes', fim && fim.status === 'done' && montarRecebeu && !('explicacoes' in (montarRecebeu.composicao_ia || {})));

      // e. JSON quebrado.
      respostaExp = () => ({ status: 200, json: { content: [{ type: 'text', text: 'não é json' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } });
      fim = await gerar(dadosBase(sinaisAlerta()), OBS);
      t('json inválido: prestação gerada sem explicacoes', fim && fim.status === 'done' && !('explicacoes' in (montarRecebeu.composicao_ia || {})));

      // f. Exceção direto na explicação (fora da rota, para não depender da ordem das chamadas).
      respostaExp = comoApi(respostaBoa()); respostaExp.lancar = true;
      const rx = await I.explicarSinais(CHAVE, dadosBase(sinaisAlerta()), OBS, {});
      t('exceção: explicarSinais não lança e devolve falha', rx && rx.ok === false && rx.motivo === 'excecao');

      // g. Modo simples com alerta: vai só a explicação na composição.
      respostaExp = comoApi(respostaBoa());
      fim = await gerar(dadosBase(sinaisAlerta(), 'simples'), '');
      t('modo simples: só a chamada de explicação', fim && fim.status === 'done' && pedidos.length === 1 && exps().length === 1);
      t('modo simples: composição só com explicacoes', montarRecebeu && montarRecebeu.composicao_ia && montarRecebeu.composicao_ia.explicacoes
        && Object.keys(montarRecebeu.composicao_ia.rubricas).length === 0);
      t('modo simples: sem observações a entrada vai com null', JSON.parse(exps()[0].corpo.messages[0].content.split('Dados (JSON):\n')[1]).observacoes_do_usuario === null);

      t('logs: chave nunca aparece', !logs.some((l) => l.includes(CHAVE)));
      t('logs: falha registrada sem derrubar', logs.some((l) => /explicacoes falharam/.test(l)) && logs.some((l) => /explicacoes ok/.test(l)));
    } catch (e) {
      falha++; escrever('FALHOU: exceção no teste ' + (e && e.stack));
    } finally {
      console.log = logOrig; console.warn = warnOrig;
      srv.close(); motor.close();
      escrever('teste-prestacao-explicacoes: ' + ok + ' ok, ' + falha + ' falha(s)');
      process.exit(falha ? 1 : 0);
    }
  });
});
