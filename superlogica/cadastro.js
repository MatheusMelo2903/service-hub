// Cadastro do condomínio no Superlógica: nome, CNPJ, endereço e síndico atual.
// Só leitura (condominios/get e sindicos/index). Devolve apenas uma lista fechada de
// campos: o condominios/get traz chaves internas (tokens de cobrança, credenciais PJ)
// que nunca podem sair do servidor.

const doisDig = (n) => String(n).padStart(2, '0');

function limpar(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

// 00197336000196 -> 00.197.336/0001-96 ; CPF 11 dígitos -> 000.000.000-00
function formatarDocumento(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return limpar(v);
}

// A API devolve "MM/DD/AAAA HH:MM:SS". Converte para Date (ou null).
function dataSL(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  return isNaN(d) ? null : d;
}
function dataBR(d) {
  return d ? doisDig(d.getUTCDate()) + '/' + doisDig(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() : '';
}

function montarEndereco(c) {
  const rua = limpar(c.st_endereco_cond);
  const num = limpar(c.st_numeroendereco_cond);
  const comp = limpar(c.st_complemento_cond);
  const linha1 = [rua, num].filter(Boolean).join(', ') + (comp ? ' ' + comp : '');
  const cidadeUf = [limpar(c.st_cidade_cond), limpar(c.st_uf_uf)].filter(Boolean).join('/');
  const cep = limpar(c.st_cep_cond);
  return {
    logradouro: rua, numero: num, complemento: comp,
    bairro: limpar(c.st_bairro_cond), cidade: limpar(c.st_cidade_cond), uf: limpar(c.st_uf_uf), cep,
    completo: [linha1.trim(), limpar(c.st_bairro_cond), cidadeUf, cep ? 'CEP ' + cep : ''].filter(Boolean).join(', '),
  };
}

const RE_SINDICO = /s[ií]ndic|president/i;
const RE_SUBSINDICO = /sub\s*-?\s*s[ií]ndic|vice/i;
const RE_CONSELHO = /conselh/i;

// Mandato vigente: entrou até hoje e não saiu (ou sai depois de hoje).
function vigente(s, hoje) {
  const ent = dataSL(s.dt_entrada_sin);
  const sai = dataSL(s.dt_saida_sin);
  return (!ent || ent <= hoje) && (!sai || sai >= hoje);
}

function resumirResponsavel(s) {
  return {
    nome: limpar(s.st_nome_sin),
    cargo: limpar(s.st_cargo_sin),
    mandato_inicio: dataBR(dataSL(s.dt_entrada_sin)),
    mandato_fim: dataBR(dataSL(s.dt_saida_sin)),
  };
}

function montarCadastro(idSuperlogica, cond, responsaveis, agora) {
  const hoje = agora || new Date();
  const lista = (Array.isArray(responsaveis) ? responsaveis : []).filter((s) => s && limpar(s.st_nome_sin));
  const atuais = lista.filter((s) => vigente(s, hoje));
  const sindicos = atuais.filter((s) => RE_SINDICO.test(s.st_cargo_sin || '') && !RE_SUBSINDICO.test(s.st_cargo_sin || ''));
  // Mais de um vigente: fica o de entrada mais recente.
  sindicos.sort((a, b) => ((dataSL(b.dt_entrada_sin) || 0) - (dataSL(a.dt_entrada_sin) || 0)));
  const doc = limpar(cond.st_cnpj_cond) || limpar(cond.st_cpf_cond);
  return {
    id_superlogica: Number(idSuperlogica),
    nome: limpar(cond.st_nome_cond),
    nome_fantasia: limpar(cond.st_fantasia_cond),
    cnpj: formatarDocumento(doc),
    endereco: montarEndereco(cond),
    ativo: String(cond.fl_ativo_cond || '1') !== '0',
    sindico: sindicos.length ? resumirResponsavel(sindicos[0]) : null,
    subsindicos: atuais.filter((s) => RE_SUBSINDICO.test(s.st_cargo_sin || '')).map(resumirResponsavel),
    conselho: atuais.filter((s) => RE_CONSELHO.test(s.st_cargo_sin || '')).map(resumirResponsavel),
  };
}

// Cache em memória: 10 minutos por condomínio.
const TTL_MS = 10 * 60 * 1000;
const _cache = new Map(); // id -> { ate, dados }

async function buscarCadastro(cliente, idSuperlogica, { semCache = false } = {}) {
  const id = String(idSuperlogica);
  const c = _cache.get(id);
  if (!semCache && c && c.ate > Date.now()) return Object.assign({ cache: true }, c.dados);
  const [condResp, resp] = await Promise.all([
    cliente.get('condominios/get', { id, somenteCondominiosAtivos: 0 }),
    cliente.get('sindicos/index', { idCondominio: id }).catch(() => []),
  ]);
  const cond = Array.isArray(condResp) ? condResp[0] : condResp;
  if (!cond || String(cond.id_condominio_cond || '') !== id) {
    const e = new Error('condominio_nao_encontrado');
    e.status = 404;
    throw e;
  }
  const dados = montarCadastro(id, cond, resp);
  _cache.set(id, { ate: Date.now() + TTL_MS, dados });
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
  return Object.assign({ cache: false }, dados);
}

module.exports = { buscarCadastro, montarCadastro, formatarDocumento, TTL_MS };
