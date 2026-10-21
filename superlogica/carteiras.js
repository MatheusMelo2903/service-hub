// Carteiras (T09): grupos de condomínios do Superlógica (condominiogrupos/index).
// Cada grupo traz a lista de códigos dos condomínios. "Carteira A", "Carteira B"
// são grupos do tipo Gerente; há também Filial e grupos comuns (por cidade, etc.).
// Só leitura. Devolve só id, nome, tipo, apelido do gerente e os códigos.

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const TIPOS = { 1: 'grupo', 2: 'gerente', 3: 'filial' };

function ids(lista) {
  return Array.from(new Set(String(lista || '').split(',').map((x) => x.trim()).filter((x) => /^[1-9][0-9]{0,8}$/.test(x)).map(Number)));
}

async function lerGrupos(cliente) {
  const j = await cliente.get('condominiogrupos/index', {});
  const arr = Array.isArray(j) ? j : [];
  return arr
    .map((g) => {
      const condominios = ids(g.lista_condominios);
      return {
        id: Number(g.id_grupo_cg) || null,
        nome: limpar(g.st_grupo_cg) || 'Grupo ' + limpar(g.id_grupo_cg),
        tipo: TIPOS[Number(g.fl_tipo_cg)] || 'grupo',
        gerente: limpar(g.st_apelido_usu),
        quantidade: condominios.length,
        condominios,
      };
    })
    .filter((g) => g.id)
    .sort((a, b) => (a.tipo === 'gerente' ? 0 : 1) - (b.tipo === 'gerente' ? 0 : 1) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

// Códigos dos condomínios das carteiras escolhidas (união). Carteira que não existe mais é ignorada.
function condominiosDasCarteiras(grupos, escolhidas) {
  const set = new Set();
  const achadas = [];
  (escolhidas || []).forEach((id) => {
    const g = grupos.find((x) => x.id === Number(id));
    if (!g) return;
    achadas.push({ id: g.id, nome: g.nome });
    g.condominios.forEach((c) => set.add(c));
  });
  return { carteiras: achadas, ids_superlogica: Array.from(set).sort((a, b) => a - b) };
}

module.exports = { lerGrupos, condominiosDasCarteiras };
