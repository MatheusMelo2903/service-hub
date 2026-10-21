// Conferência de duplicadas para o Normalizar via IA (T06).
// Lê as unidades do condomínio no Superlógica (unidades/index com contatos) e diz,
// para cada linha da prévia, se a unidade já existe e se a pessoa já está cadastrada
// (por CPF/CNPJ no condomínio todo ou pelo nome na mesma unidade).
// CPF, email e telefone dos cadastros existentes NUNCA saem do servidor: a resposta
// só leva sim/não, o motivo e o nome da unidade onde bateu.

const POR_PAGINA = 50;
const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const digitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// "Apto 0101" -> "101"; "Sala 3-B" -> "3b". Tira prefixos comuns e zeros à esquerda.
function chaveUnidade(v) {
  let s = semAcento(limpar(v)).toLowerCase();
  s = s.replace(/^(apartamento|apto|ap|sala|casa|loja|lote|cob)\.?\s*(?=\d)/, '');
  s = s.replace(/\b(apartamento|apto|ap|unidade|un|sala|casa|loja|lote|cobertura|cob)\b\.?/g, ' ');
  s = s.replace(/[^a-z0-9]/g, '');
  return s.replace(/^0+(?=\d)/, '');
}
// "Bloco A" -> "a"; "Torre 01" -> "1"; vazio continua vazio.
function chaveBloco(v) {
  let s = semAcento(limpar(v)).toLowerCase();
  s = s.replace(/\b(bloco|bl|torre|tr|edificio|ed)\b\.?/g, ' ');
  s = s.replace(/[^a-z0-9]/g, '');
  return s.replace(/^0+(?=\d)/, '');
}
function chaveNome(v) {
  return semAcento(limpar(v)).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Lê todas as unidades do condomínio (até 40 páginas = 2000 unidades).
async function lerUnidades(cliente, id) {
  const itens = [];
  let truncado = false;
  for (let pg = 1; pg <= 40; pg++) {
    const j = await cliente.get('unidades/index', { idCondominio: id, exibirDadosDosContatos: 1, itensPorPagina: POR_PAGINA, pagina: pg });
    if (!Array.isArray(j) || !j.length) break;
    j.forEach((x) => itens.push(x));
    if (j.length < POR_PAGINA) break;
    if (pg === 40) truncado = true;
  }
  return { itens: itens.map(resumirUnidade), truncado };
}

// Guarda só o necessário para comparar (fica em memória no servidor, no cache curto).
function resumirUnidade(u) {
  const contatos = (Array.isArray(u.contatos) ? u.contatos : [])
    .filter((c) => !limpar(c.dt_saida_res))
    .map((c) => ({ nome: chaveNome(c.st_nome_con), doc: digitos(c.st_cpf_con) || digitos(c.st_cgc_con) }))
    .filter((c) => c.nome || c.doc);
  const prop = chaveNome(u.nome_proprietario);
  const docProp = digitos(u.cpf_proprietario);
  if (prop && !contatos.some((c) => c.nome === prop)) contatos.push({ nome: prop, doc: docProp });
  const unidade = limpar(u.st_unidade_uni);
  const bloco = limpar(u.st_bloco_uni);
  return { rotulo: unidade + (bloco ? ' ' + bloco : ''), u: chaveUnidade(unidade), b: chaveBloco(bloco), contatos };
}

// linhas: [{ unidade, bloco, nome, cpf, cnpj }]. Devolve um resultado por linha, na mesma ordem.
function conferir(existentes, linhas) {
  const porUnidade = new Map();
  const porDoc = new Map();
  existentes.forEach((e) => {
    if (!porUnidade.has(e.u)) porUnidade.set(e.u, []);
    porUnidade.get(e.u).push(e);
    e.contatos.forEach((c) => { if (c.doc && (c.doc.length === 11 || c.doc.length === 14) && !porDoc.has(c.doc)) porDoc.set(c.doc, e.rotulo); });
  });
  return linhas.map((l) => {
    const u = chaveUnidade(l && l.unidade);
    const b = chaveBloco(l && l.bloco);
    let unidade = null;
    if (u && porUnidade.has(u)) {
      const cands = porUnidade.get(u);
      const mesmoBloco = cands.filter((e) => e.b === b);
      if (mesmoBloco.length) unidade = mesmoBloco[0];
      // Linha sem bloco: com uma única unidade com esse número, é ela; com várias (blocos
      // diferentes), importar sem bloco quase certamente duplica uma delas. Marca as duas.
      else if (!b && cands.length === 1) unidade = cands[0];
      else if (!b && cands.length > 1) unidade = { rotulo: cands.map((e) => e.rotulo).join(', ') + ' (informe o bloco)', contatos: [].concat(...cands.map((e) => e.contatos)) };
    }
    const doc = digitos(l && l.cpf) || digitos(l && l.cnpj);
    const nome = chaveNome(l && l.nome);
    let pessoa = null;
    if (doc && (doc.length === 11 || doc.length === 14) && porDoc.has(doc)) pessoa = { por: 'cpf', onde: porDoc.get(doc) };
    else if (unidade && nome && unidade.contatos.some((c) => c.nome === nome)) pessoa = { por: 'nome', onde: unidade.rotulo };
    return {
      unidade_existe: !!unidade,
      unidade_rotulo: unidade ? unidade.rotulo : '',
      pessoa_existe: !!pessoa,
      pessoa_por: pessoa ? pessoa.por : '',
      pessoa_onde: pessoa ? pessoa.onde : '',
    };
  });
}

module.exports = { lerUnidades, conferir, chaveUnidade, chaveBloco, chaveNome };
