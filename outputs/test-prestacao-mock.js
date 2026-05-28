// Test mock da Onda 1 do gerador de prestação de contas.
// Carrega public/prestacao.js em ambiente node com stubs (PptxGenJS, document,
// window, supaFetch, apiAuthFetch, toast) e roda prestacaoMontarPptx contra
// dados realísticos baseados no template_prestacao.py (Associação Maçônica
// Cidade de Vitória, exercício 2025).
//
// Verifica:
//   1. Agrupamento: prestacaoAgruparDespesas produz 9 buckets na ordem canônica
//   2. Total de slides gerados: 17 (1 capa + 6 analíticos + 9 detalhamentos + 1 encerramento)
//   3. Títulos têm acentos corretos (nenhum VISAO/EVOLUCAO/etc CAPS bruto)
//   4. Detalhamentos usam nomes curados (nenhum "DESPESA COM PESSOAL" no título)
//   5. Descrições curatoriais aparecem (não "Maior categoria do exercício")

const fs = require('fs');

// ─── Stubs globais ─────────────────────────────────────────────────────
const slidesGerados = [];
const textosTodos = [];

function makeSlideMock() {
  const slide = {
    _texts: [],
    _shapes: [],
    _charts: [],
    background: null,
    addText: function(content, options) {
      // content pode ser string ou array de { text, options }
      if (typeof content === 'string') {
        this._texts.push(content);
        textosTodos.push(content);
      } else if (Array.isArray(content)) {
        content.forEach(function(p) {
          if (p && p.text) {
            this._texts.push(p.text);
            textosTodos.push(p.text);
          }
        }.bind(this));
      }
      return this;
    },
    addShape: function() { this._shapes.push(arguments); return this; },
    addChart: function() { this._charts.push(arguments); return this; },
  };
  return slide;
}

class PptxGenJSMock {
  constructor() {
    this.slides = slidesGerados;
    this.ChartType = { line: 'line', bar: 'bar', area: 'area', column: 'column' };
  }
  defineLayout() {}
  set layout(v) { this._layout = v; }
  get layout() { return this._layout; }
  addSlide() {
    const s = makeSlideMock();
    this.slides.push(s);
    return s;
  }
  async writeFile(opts) { return opts && opts.fileName; }
}

global.PptxGenJS = PptxGenJSMock;
global.document = {
  addEventListener: function() {},
  getElementById: function() { return null; }
};
global.window = global;
global.supaFetch = async function() { return []; };
global.apiAuthFetch = async function() { return { ok: true, json: async function() { return {}; }, text: async function() { return ''; } }; };
global.toast = function() {};
global.alert = function() {};
global.confirm = function() { return true; };

// ─── Carrega prestacao.js via indirect eval (escopo global) ──────────
const code = fs.readFileSync('public/prestacao.js', 'utf8');
(0, eval)(code);

// ─── Dados mock baseados no template_prestacao.py ────────────────────
const dadosMock = {
  cabecalho: {
    condominio: 'Associação Maçônica Cidade de Vitória',
    periodo: 'Janeiro a Dezembro 2025',
    dataApresentacao: '2026-01-15'
  },
  saldo: { inicial: 21040.97, final: 40932.91, movimentacao: 19891.94 },
  saldoMensal: [
    21040.97, 21414.61, 18091.34, 23544.39, 22872.22, 21007.49,
    26049.23, 29381.36, 32791.61, 30658.12, 31724.49, 32762.38, 40932.91
  ],
  receitas: {
    total: 116572.72,
    granularidade: 'mensal',
    distribuicaoTemporalTotal: [6099.26, 6423.62, 12336.35, 8612.85, 7965.46, 11864.59, 10145.25, 9421.49, 8506.36, 10865.71, 10478.22, 13853.56],
    porCategoria: [
      { categoria: 'Taxa de Condomínio', valor: 108717.31, granularidade: 'mensal', distribuicaoTemporal: new Array(12).fill(108717.31 / 12) },
      { categoria: 'Acordos', valor: 4737.86, granularidade: 'mensal', distribuicaoTemporal: new Array(12).fill(4737.86 / 12) },
      { categoria: 'Energia Comum', valor: 2235.85, granularidade: 'mensal', distribuicaoTemporal: null },
      { categoria: 'Salão de Festas', valor: 511.94, granularidade: 'mensal', distribuicaoTemporal: null },
      { categoria: 'Outras Receitas', valor: 369.76, granularidade: 'mensal', distribuicaoTemporal: null }
    ]
  },
  despesas: {
    total: 96680.78,
    granularidade: 'mensal',
    distribuicaoTemporalTotal: [5725.62, 9746.89, 6883.30, 9285.02, 9830.19, 6822.85, 6813.12, 6011.24, 10639.85, 9799.34, 9440.33, 5683.03]
  },
  // Subcategorias detalhadas (cenário real do Superlógica que gerava 49 slides).
  // Cada uma mapeada para 1 dos 9 grupos canônicos via PRESTACAO_SUBCATEGORY_TO_GROUP.
  despesasPorCategoria: [
    // Despesas com pessoal (1 subcategoria → mapeia via 'Salários')
    { categoria: 'Salários Contratados', valor: 36000.00, granularidade: 'mensal', distribuicaoTemporal: new Array(12).fill(3000) },
    // Despesas com consumo (4 subcategorias)
    { categoria: 'Energia Elétrica', valor: 11849.05, granularidade: 'mensal', distribuicaoTemporal: [397.83, 941.99, 1168.90, 1122.46, 1029.04, 926.82, 784.03, 827.84, 1049.95, 1110.08, 1083.42, 1406.69] },
    { categoria: 'Gás', valor: 4040.00, granularidade: 'mensal', distribuicaoTemporal: [260, 0, 650, 0, 520, 0, 910, 520, 260, 0, 460, 460] },
    { categoria: 'Internet', valor: 1321.43, granularidade: 'mensal', distribuicaoTemporal: [119.90, 119.90, 122.43, 119.90, 119.90, 119.90, 119.90, 119.90, 119.90, 119.90, 119.90, 0] },
    { categoria: 'Água e Esgoto', valor: 2128.69, granularidade: 'mensal', distribuicaoTemporal: [119.66, 85.02, 163.82, 163.30, 148.66, 163.82, 223.97, 255.08, 171.88, 462.42, 171.06, 0] },
    // Despesas administrativas (2 subcategorias)
    { categoria: 'Honorários Administrativos', valor: 6349.85, granularidade: 'mensal', distribuicaoTemporal: new Array(12).fill(529.15) },
    { categoria: 'Cartório', valor: 5254.38, granularidade: 'mensal', distribuicaoTemporal: [421.83, 2864.15, 72.61, 1895.79, 0, 0, 0, 0, 0, 0, 0, 0] },
    // Retenções e tributos (1 subcategoria via 'DARF')
    { categoria: 'DARF Simples Nacional', valor: 573.30, granularidade: 'mensal', distribuicaoTemporal: [0, 0, 0, 0, 0, 81.90, 81.90, 81.90, 81.90, 81.90, 81.90, 81.90] },
    // Aquisição de materiais (5 subcategorias)
    { categoria: 'Material de Limpeza', valor: 1739.98, granularidade: 'mensal', distribuicaoTemporal: [219.35, 390.17, 0, 0, 785.35, 0, 0, 0, 345.11, 0, 0, 0] },
    { categoria: 'Material Elétrico', valor: 288.29, granularidade: 'mensal', distribuicaoTemporal: [0, 0, 0, 0, 0, 159.60, 0, 48.89, 79.80, 0, 0, 0] },
    { categoria: 'Material de Construção', valor: 455.00, granularidade: 'mensal', distribuicaoTemporal: [0, 0, 0, 455.00, 0, 0, 0, 0, 0, 0, 0, 0] },
    // Contratos de manutenção (2 subcategorias)
    { categoria: 'Elevador', valor: 2797.28, granularidade: 'mensal', distribuicaoTemporal: [237, 237, 267.28, 257, 257, 257, 257, 257, 257, 257, 257, 0] },
    { categoria: 'CFTV', valor: 2312.64, granularidade: 'mensal', distribuicaoTemporal: [208.48, 208.48, 227.84, 208.48, 416.96, 0, 208.48, 208.48, 208.48, 208.48, 208.48, 0] },
    // Serviços contratados (2 subcategorias)
    { categoria: 'Seguro Condominial', valor: 2202.70, granularidade: 'mensal', distribuicaoTemporal: [0, 0, 291.06, 724.26, 1187.38, 0, 0, 0, 0, 0, 0, 0] },
    { categoria: 'Sistema de Incêndio', valor: 1960.00, granularidade: 'mensal', distribuicaoTemporal: [0, 560, 0, 0, 0, 1400, 0, 0, 0, 0, 0, 0] },
    // Despesas financeiras (2 subcategorias)
    { categoria: 'Tarifas Bancárias', valor: 2161.81, granularidade: 'mensal', distribuicaoTemporal: [138.70, 144.70, 201.88, 185.13, 266.16, 174.01, 157.61, 154.65, 155.95, 249.71, 148.72, 184.59] },
    { categoria: 'IRRF Poupança', valor: 2.30, granularidade: 'mensal', distribuicaoTemporal: [0, 0, 0, 0, 0, 2.30, 0, 0, 0, 0, 0, 0] },
    // Investimento (imobilizado) (2 subcategorias)
    { categoria: 'Móveis e Mobiliário', valor: 800.00, granularidade: 'mensal', distribuicaoTemporal: [0, 0, 0, 0, 0, 0, 0, 0, 800, 0, 0, 0] },
    { categoria: 'Eletrodomésticos', valor: 200.00, granularidade: 'mensal', distribuicaoTemporal: [0, 0, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0] }
  ]
};

// ─── Roda o gerador ────────────────────────────────────────────────────
(async function() {
  // Teste 1: Agrupamento
  const grupos = prestacaoAgruparDespesas(dadosMock.despesasPorCategoria);
  console.log('=== Agrupamento ===');
  console.log('Total grupos gerados:', grupos.length);
  grupos.forEach(function(g) {
    console.log('  ' + g.grupo + ': R$ ' + g.total.toFixed(2) + ' (' + g.subcategorias.length + ' subcategorias)');
  });

  const fontes = prestacaoAgruparReceitas(dadosMock.receitas.porCategoria);
  console.log('\n=== Fontes de receita ===');
  console.log('Total fontes:', fontes.length);
  fontes.forEach(function(f) {
    console.log('  ' + f.fonte + ': R$ ' + f.total.toFixed(2));
  });

  // Teste 2: Pipeline completo
  await prestacaoMontarPptx(dadosMock);
  console.log('\n=== Slides gerados ===');
  console.log('Total slides:', slidesGerados.length);

  // Teste 3: Acentos em todos os textos
  const captarSemAcento = textosTodos.filter(function(t) {
    return /\b(PRESTACAO|VISAO|EVOLUCAO|EXERCICIO|MANUTENCAO|PATRIMONIO|SUPERAVIT|LANCAMENTOS|DISTRIBUICAO|BALANCO|LIQUIDO|PERIODO|INICIO)\b/.test(t);
  });
  console.log('\n=== Acentos ===');
  console.log('Textos com CAPS sem acento:', captarSemAcento.length);
  if (captarSemAcento.length) captarSemAcento.slice(0, 5).forEach(function(t) { console.log('  ! ' + t); });

  // Teste 4: Nenhum CAPS bruto Superlógica no INÍCIO de string (não cabeçalho TOTAL).
  // Exclui labels legítimos do rodapé navy "TOTAL DESPESAS COM PESSOAL".
  const capsBruto = textosTodos.filter(function(t) {
    if (/^TOTAL /.test(t)) return false; // label de total navy é legítimo
    return /^(DESPESA COM PESSOAL|DESPESAS COM CONSUMO|MANUTENÇÃO|AQUISIÇÃO DE MATERIAIS|RETENÇÕES|ADMINISTRATIVO)$/.test(t);
  });
  console.log('CAPS bruto Superlógica nos slides:', capsBruto.length);
  if (capsBruto.length) capsBruto.forEach(function(t) { console.log('  flagged:', JSON.stringify(t)); });

  // Teste 5: Descrições curatoriais aparecem
  const desc = textosTodos.filter(function(t) {
    return /Contrato mensal de mão de obra terceirizada|Despesas com concessionárias|Contratos mensais de manutenção preventiva/.test(t);
  });
  console.log('\n=== Descrições curatoriais ===');
  console.log('Descrições curatoriais presentes:', desc.length);

  // Teste 6: Genéricas anteriores NÃO devem aparecer
  const genericas = textosTodos.filter(function(t) {
    return /^Maior categoria do exercício\.$|^Categoria componente do exercício\.$|^Categoria de peso significativo/.test(t);
  });
  console.log('Descrições genéricas anteriores:', genericas.length);

  // ─── Veredicto ─────────
  const passos = [
    ['Agrupamento: 9 grupos', grupos.length === 9],
    ['Slides: 17 total', slidesGerados.length === 17],
    ['Acentos: 0 CAPS sem acento', captarSemAcento.length === 0],
    ['Nomes curados: 0 CAPS bruto Superlógica', capsBruto.length === 0],
    ['Descrições curatoriais presentes', desc.length >= 3],
    ['Descrições genéricas removidas', genericas.length === 0]
  ];
  let pass = 0;
  console.log('\n=== Veredicto Onda 1 ===');
  passos.forEach(function(p) {
    console.log((p[1] ? '✅' : '❌') + ' ' + p[0]);
    if (p[1]) pass++;
  });
  console.log('\n' + pass + '/' + passos.length + ' critérios passaram.');
  process.exit(pass === passos.length ? 0 : 1);
})();
