// ─────────────────────────────────────────────────────────────────────────
// HARNESS T46: inserção POR TRECHO x reescrita inteira, com a API de verdade.
// Para cada caso: gera a ata base (ou usa uma base pronta), roda a auditoria de completude
// igual ao motor, e insere as MESMAS lacunas dos dois jeitos. Compara tempo, tokens de saída,
// lacunas de valor que entraram, quanto do texto base sobreviveu e o gate de cada versão.
// Dados de cliente NUNCA entram no repo: casos e saídas ficam em OUT (fora do repo).
//
// Rodar (o segredo é injetado pelo railway run, nunca impresso):
//   railway run -s <service-hub> -e <dev> -- node scripts/ata-harness/insercao-trecho-harness.cjs
// OUT/casos.json: [{ "id", "transcricao", "edital"?, "base"?, "condominio", "tipo", "data" }]
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const S = require('../../server.js');

const OUT = process.env.OUT || path.join(process.env.HOME || '.', 'v8s/EXECUCAO/testes/T46');
const CASOS = JSON.parse(fs.readFileSync(path.join(OUT, 'casos.json'), 'utf8'));
const MODELO = 'modelo_da_ata';
const log = (m) => { const l = '[' + new Date().toISOString().slice(11, 19) + '] ' + m; console.log(l); fs.appendFileSync(path.join(OUT, 'harness.log'), l + '\n'); };
const fmtBRL = (c) => 'R$ ' + c.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Chamada contada: soma tokens de saída e tempo por etapa.
function contador() {
  const uso = { saida: 0, entrada: 0 };
  const chamar = async (modelo, max, sys, msg, cache) => {
    const r = await S.chamarAnthropicAta(modelo, max, sys, msg, cache, { funcao: 'harness_t46' });
    const u = r && r.raw && r.raw.usage;
    if (u) { uso.saida += u.output_tokens || 0; uso.entrada += u.input_tokens || 0; }
    return r;
  };
  return { chamar, uso };
}

function userMessage(c, trans) {
  const edital = c.edital && fs.existsSync(c.edital) ? fs.readFileSync(c.edital, 'utf8') : '';
  return [
    '=== DADOS DA REUNIÃO ===', 'Condomínio: ' + c.condominio, 'Tipo: ' + c.tipo, 'Data: ' + c.data, '',
    '=== ITENS DE PAUTA ===', '(extrair da transcrição e/ou dos editais anexados abaixo)',
    edital ? '\n=== EDITAIS / DOCUMENTOS ANEXADOS ===\n--- 1. (edital de convocação) ---\n' + edital + '\n' : '',
    '=== PARTICIPANTES ===', '(extrair da transcrição; se não identificáveis, use [a confirmar])', '',
    '=== TRANSCRIÇÃO COMPLETA DA REUNIÃO ===', trans, '',
    'Gere a ata completa seguindo todas as regras e estrutura do sistema. Use [a confirmar] em qualquer dado ausente.'
  ].join('\n');
}

// Mesma lista de lacunas do motor: auditoria por bloco (em paralelo) + valores da fala ausentes.
async function lacunas(ata, trans, chamar) {
  const blocos = S.dividirEmBlocos(trans, S.numBlocosAuditoria(trans));
  const res = await Promise.all(blocos.map((b, i) => S.auditarBlocoCompletude(ata, b, i + 1, blocos.length, chamar, '')));
  let lac = '';
  for (const r of res) if (r && /LACUNA/i.test(r) && !/^NENHUMA LACUNA\s*$/i.test(r)) lac += r + '\n';
  const canonAta = S.valoresCanonicos(ata);
  const ja = S.valoresCanonicos(lac);
  const vistos = new Set();
  const det = [];
  for (const m of S.mencoesMonetarias(trans)) {
    if (canonAta.has(m.canon) || ja.has(m.canon) || vistos.has(m.canon)) continue;
    vistos.add(m.canon);
    det.push('LACUNA (' + fmtBRL(m.canon) + '): valor dito na assembleia. Insira SOMENTE se fizer parte de um assunto tratado, no sentido exato da fala (valor real, proposta, exemplo, simulação ou conta); se for exemplo, registre como exemplo; se for comentário paralelo, NÃO insira. Trecho: "' + m.trecho + '"');
  }
  return [lac.trim(), det.join('\n')].filter(Boolean).join('\n').trim();
}

// Fração das frases da base que continuam IDÊNTICAS na versão final (mede reescrita indevida).
function sobrevivencia(base, final) {
  const frases = base.split(/(?<=[.;:])\s+/).map((f) => f.trim()).filter((f) => f.length > 40);
  if (!frases.length) return 1;
  return frases.filter((f) => final.includes(f)).length / frases.length;
}

async function rodarCaso(c) {
  const trans = fs.readFileSync(c.transcricao, 'utf8');
  const dir = path.join(OUT, c.id);
  fs.mkdirSync(dir, { recursive: true });
  const sys = S.montarSystemAta();
  let base = c.base && fs.existsSync(c.base) ? fs.readFileSync(c.base, 'utf8') : '';
  if (!base) {
    const k = contador(); const t0 = Date.now();
    const r = await k.chamar(MODELO, 32000, sys, userMessage(c, trans));
    base = (r && r.texto) || '';
    log(c.id + ': base gerada em ' + Math.round((Date.now() - t0) / 1000) + 's, ' + base.length + ' chars');
  }
  if (!base) { log(c.id + ': SEM BASE, pulando'); return null; }
  fs.writeFileSync(path.join(dir, 'base.txt'), base);
  const kl = contador(); const tl = Date.now();
  const lista = await lacunas(base, trans, kl.chamar);
  fs.writeFileSync(path.join(dir, 'lacunas.txt'), lista || '(nenhuma)');
  const nLac = (lista.match(/^LACUNA/gim) || []).length;
  log(c.id + ': ' + nLac + ' lacunas em ' + Math.round((Date.now() - tl) / 1000) + 's');
  if (!lista) return { id: c.id, lacunas: 0 };

  // Os dois jeitos em paralelo, mesmas lacunas, mesma base.
  const kA = contador(), kB = contador();
  const tA = Date.now(), tB = Date.now();
  const [a, b] = await Promise.all([
    S.inserirLacunasNaAta(base, lista, MODELO, kA.chamar, '').then((x) => { kA.ms = Date.now() - tA; return x; }),
    S.inserirLacunasPorTrecho(base, lista, MODELO, kB.chamar, '').then((x) => { kB.ms = Date.now() - tB; return x; })
  ]);
  const ataA = a || base;
  const ataB = (b && b.ata) || base;
  fs.writeFileSync(path.join(dir, 'A-reescrita.txt'), ataA);
  fs.writeFileSync(path.join(dir, 'B-trecho.txt'), ataB);
  if (b) fs.writeFileSync(path.join(dir, 'B-operacoes.json'), JSON.stringify(b, (k, v) => (k === 'ata' ? undefined : v), 2));

  // Valores das lacunas que entraram em cada versão (e não estavam na base).
  const canonBase = S.valoresCanonicos(base);
  const valLac = [...S.valoresCanonicos(lista)].filter((v) => !canonBase.has(v));
  const cA = S.valoresCanonicos(ataA), cB = S.valoresCanonicos(ataB);
  const gate = (t) => { try { const g = S.gateDeSaida(t, trans); return (g.flags || []).length; } catch (e) { return -1; } };
  const res = {
    id: c.id, lacunas: nLac, valores_novos_nas_lacunas: valLac.length,
    A: { segundos: Math.round(kA.ms / 1000), tokens_saida: kA.uso.saida, valores_inseridos: valLac.filter((v) => cA.has(v)).length, texto_base_preservado: +sobrevivencia(base, ataA).toFixed(3), tamanho: ataA.length, gate_flags: gate(ataA), valida: S.validarAta(ataA).pareceAta },
    B: { segundos: Math.round(kB.ms / 1000), tokens_saida: kB.uso.saida, operacoes: b ? b.operacoes : null, aplicadas: b ? b.aplicadas : null, falhas: b ? b.falhas : null, valores_inseridos: valLac.filter((v) => cB.has(v)).length, texto_base_preservado: +sobrevivencia(base, ataB).toFixed(3), tamanho: ataB.length, gate_flags: gate(ataB), valida: S.validarAta(ataB).pareceAta },
    base: { tamanho: base.length, gate_flags: gate(base) }
  };
  log(c.id + ': ' + JSON.stringify(res));
  return res;
}

(async () => {
  const filtro = process.env.CASO;
  const casos = CASOS.filter((c) => !filtro || c.id === filtro);
  const todos = await Promise.all(casos.map((c) => rodarCaso(c).catch((e) => { log(c.id + ': ERRO ' + e.message); return null; })));
  fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify(todos, null, 2));
  log('FIM');
  process.exit(0);
})();
