'use strict';
// Onde a conciliação do dia guarda o que planejou e o que gravou (tabelas fin_conc_*, migration 029).
// Duas versões com a mesma interface: Supabase (servidor, service_role) e memória (testes e o
// teste de verdade no 167). Número de conta e agência nunca são guardados: só o código da conta.
// A trava "nunca importar período já importado" também está no banco: restrição de exclusão por
// conta e período nas importações gravando, gravadas ou incertas.

const enc = encodeURIComponent;
const agoraISO = () => new Date().toISOString();
const lista = (v) => [].concat(v).map(String);

function erroSobreposicao() { const e = new Error('sobreposicao'); e.codigo = 'sobreposicao'; return e; }

// req(method, caminho, corpo) -> { status, body } (supabaseAdminRequest do servidor).
function criarArmazemSupabase(req) {
  async function chamar(metodo, caminho, corpo) {
    const r = await req(metodo, '/rest/v1/' + caminho, corpo);
    if (r.status >= 200 && r.status < 300) return r.body;
    const e = new Error('armazem_' + r.status);
    e.status = r.status;
    const t = JSON.stringify(r.body || '');
    if (/fin_conc_importacoes_sem_sobreposicao|23P01|conflicting key value violates exclusion/.test(t)) e.codigo = 'sobreposicao';
    if (/23505|duplicate key/.test(t)) e.codigo = 'duplicado';
    throw e;
  }
  const filtroIn = (campo, v) => campo + '=in.(' + lista(v).map((x) => '"' + x.replace(/"/g, '') + '"').join(',') + ')';
  // Insere só as linhas cuja chave ainda não existe (a mesma linha nunca entra duas vezes).
  async function inserirNovas(tabela, linhas, campoChave) {
    if (!linhas.length) return 0;
    let n = 0;
    for (let i = 0; i < linhas.length; i += 200) {
      const lote = linhas.slice(i, i + 200);
      const existentes = new Set((await chamar('GET', tabela + '?select=' + campoChave + '&' + filtroIn(campoChave, lote.map((l) => l[campoChave])))).map((x) => String(x[campoChave])));
      const novas = lote.filter((l) => !existentes.has(String(l[campoChave])));
      if (!novas.length) continue;
      try { await chamar('POST', tabela, novas); n += novas.length; } catch (e) {
        if (e.codigo !== 'duplicado') throw e;
        for (const l of novas) { try { await chamar('POST', tabela, l); n++; } catch (e2) { if (e2.codigo !== 'duplicado') throw e2; } }
      }
    }
    return n;
  }
  // Atualiza só se o status ainda é o esperado (assim duas gravações nunca pegam o mesmo item).
  async function trocar(tabela, campoChave, chave, de, campos) {
    const cond = de ? '&' + filtroIn('status', de) : '';
    const r = await chamar('PATCH', tabela + '?' + campoChave + '=eq.' + enc(chave) + cond, Object.assign({ atualizado_em: agoraISO() }, campos));
    return Array.isArray(r) && r.length ? r[0] : null;
  }
  return {
    tipo: 'supabase',
    importacoes: {
      listar: ({ id_condominio, id_conta, status }) => chamar('GET', 'fin_conc_importacoes?select=*' + (id_condominio ? '&id_condominio=eq.' + enc(id_condominio) : '') + (id_conta ? '&id_conta=eq.' + enc(id_conta) : '') + (status ? '&' + filtroIn('status', status) : '') + '&order=inicio.asc&limit=500'),
      criar: async (l) => { const r = await chamar('POST', 'fin_conc_importacoes', l); return Array.isArray(r) ? r[0] : r; },
      trocar: (id, de, campos) => trocar('fin_conc_importacoes', 'id', id, de, campos),
      cancelarPlanejadas: (idConta) => chamar('PATCH', 'fin_conc_importacoes?id_conta=eq.' + enc(idConta) + '&status=eq.planejada', { status: 'cancelada', atualizado_em: agoraISO() }),
    },
    fila: {
      listar: ({ id_condominio, status }) => chamar('GET', 'fin_conc_fila?select=*' + (id_condominio ? '&' + filtroIn('id_condominio', id_condominio) : '') + (status ? '&' + filtroIn('status', status) : '') + '&order=data.asc&limit=3000'),
      pegar: async (chave) => (await chamar('GET', 'fin_conc_fila?select=*&chave=eq.' + enc(chave) + '&limit=1'))[0] || null,
      inserirNovas: (linhas) => inserirNovas('fin_conc_fila', linhas, 'chave'),
      trocar: (chave, de, campos) => trocar('fin_conc_fila', 'chave', chave, de, campos),
      marcarVistas: (idCond, chaves, quando) => (chaves.length ? chamar('PATCH', 'fin_conc_fila?id_condominio=eq.' + enc(idCond) + '&' + filtroIn('chave', chaves), { visto_em: quando }) : Promise.resolve()),
      // Pendente que a conciliação de hoje não achou mais: alguém resolveu direto no Superlógica.
      // A linha que veio do arquivo (faltando no Superlógica) não sai sozinha.
      resolverSumidas: (idCond, antesDe) => chamar('PATCH', 'fin_conc_fila?id_condominio=eq.' + enc(idCond) + '&status=eq.pendente&tipo=neq.faltando_no_superlogica&visto_em=lt.' + enc(antesDe), { status: 'resolvido', atualizado_em: agoraISO() }),
    },
    lancamentos: {
      listar: ({ id_condominio, status }) => chamar('GET', 'fin_conc_lancamentos?select=*' + (id_condominio ? '&' + filtroIn('id_condominio', id_condominio) : '') + (status ? '&' + filtroIn('status', status) : '') + '&order=criado_em.asc&limit=2000'),
      pegar: async (chave) => (await chamar('GET', 'fin_conc_lancamentos?select=*&chave=eq.' + enc(chave) + '&limit=1'))[0] || null,
      inserirNovos: (linhas) => inserirNovas('fin_conc_lancamentos', linhas, 'chave'),
      trocar: (chave, de, campos) => trocar('fin_conc_lancamentos', 'chave', chave, de, campos),
    },
    regras: {
      listar: (idCond) => chamar('GET', 'fin_conc_regras?select=*&ativo=eq.true&id_condominio=eq.' + enc(idCond) + '&limit=500'),
      salvar: (l) => chamar('POST', 'fin_conc_regras?on_conflict=id_condominio,padrao,sinal', l).catch((e) => {
        if (e.codigo !== 'duplicado') throw e;
        return chamar('PATCH', 'fin_conc_regras?id_condominio=eq.' + enc(l.id_condominio) + '&padrao=eq.' + enc(l.padrao) + '&sinal=eq.' + enc(l.sinal), l);
      }),
    },
    avisos: {
      gravarDia: async (dia, linhas) => {
        await chamar('DELETE', 'fin_conc_avisos?dia=eq.' + enc(dia));
        for (let i = 0; i < linhas.length; i += 500) await chamar('POST', 'fin_conc_avisos', linhas.slice(i, i + 500));
      },
      listar: (dia, ids) => chamar('GET', 'fin_conc_avisos?select=*&dia=eq.' + enc(dia) + (ids ? '&' + filtroIn('id_condominio', ids.length ? ids : ['0']) : '') + '&limit=5000'),
      ultimoDia: async () => { const r = await chamar('GET', 'fin_conc_avisos?select=dia&order=dia.desc&limit=1'); return r[0] ? r[0].dia : null; },
    },
    estado: {
      salvar: (l) => chamar('POST', 'fin_conc_estado', l).catch((e) => {
        if (e.codigo !== 'duplicado') throw e;
        return chamar('PATCH', 'fin_conc_estado?id_condominio=eq.' + enc(l.id_condominio), l);
      }),
      listar: (ids) => chamar('GET', 'fin_conc_estado?select=*' + (ids ? '&' + filtroIn('id_condominio', ids.length ? ids : ['0']) : '') + '&limit=1000'),
    },
  };
}

// Mesma interface, na memória (testes). Inclui a trava de sobreposição.
function criarArmazemMemoria() {
  const t = { imp: [], fila: new Map(), lanc: new Map(), regras: [], avisos: [], estado: new Map() };
  let seq = 0;
  const copia = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);
  const ATIVAS = new Set(['gravando', 'gravada', 'incerta']);
  const sobrepoe = (a, b) => String(a.id_conta) === String(b.id_conta) && a.inicio <= b.fim && b.inicio <= a.fim;
  const filtra = (l, o) => l.filter((x) => (!o.id_condominio || lista(o.id_condominio).includes(String(x.id_condominio))) && (!o.status || lista(o.status).includes(x.status)) && (!o.id_conta || String(x.id_conta) === String(o.id_conta)));
  const trocarMapa = (m, chave, de, campos) => {
    const x = m.get(chave);
    if (!x || (de && !lista(de).includes(x.status))) return null;
    Object.assign(x, campos, { atualizado_em: agoraISO() });
    return copia(x);
  };
  return {
    tipo: 'memoria', _t: t,
    importacoes: {
      listar: async (o) => copia(filtra(t.imp, o)).sort((a, b) => (a.inicio < b.inicio ? -1 : 1)),
      criar: async (l) => { const x = Object.assign({ id: ++seq, criado_em: agoraISO() }, copia(l)); t.imp.push(x); return copia(x); },
      trocar: async (id, de, campos) => {
        const x = t.imp.find((i) => String(i.id) === String(id));
        if (!x || (de && !lista(de).includes(x.status))) return null;
        const novo = Object.assign({}, x, campos);
        if (ATIVAS.has(novo.status) && t.imp.some((o) => o !== x && ATIVAS.has(o.status) && sobrepoe(o, novo))) throw erroSobreposicao();
        Object.assign(x, campos, { atualizado_em: agoraISO() });
        return copia(x);
      },
      cancelarPlanejadas: async (idConta) => { t.imp.forEach((i) => { if (String(i.id_conta) === String(idConta) && i.status === 'planejada') i.status = 'cancelada'; }); },
    },
    fila: {
      listar: async (o) => copia(filtra([...t.fila.values()], o)),
      pegar: async (k) => copia(t.fila.get(k) || null),
      inserirNovas: async (l) => { let n = 0; l.forEach((x) => { if (!t.fila.has(x.chave)) { t.fila.set(x.chave, Object.assign({ criado_em: agoraISO() }, copia(x))); n++; } }); return n; },
      trocar: async (k, de, c) => trocarMapa(t.fila, k, de, c),
      marcarVistas: async (idCond, chaves, quando) => { chaves.forEach((k) => { const x = t.fila.get(k); if (x) x.visto_em = quando; }); },
      resolverSumidas: async (idCond, antesDe) => { t.fila.forEach((x) => { if (String(x.id_condominio) === String(idCond) && x.status === 'pendente' && x.tipo !== 'faltando_no_superlogica' && (x.visto_em || '') < antesDe) x.status = 'resolvido'; }); },
    },
    lancamentos: {
      listar: async (o) => copia(filtra([...t.lanc.values()], o)),
      pegar: async (k) => copia(t.lanc.get(k) || null),
      inserirNovos: async (l) => { let n = 0; l.forEach((x) => { if (!t.lanc.has(x.chave)) { t.lanc.set(x.chave, Object.assign({ criado_em: agoraISO() }, copia(x))); n++; } }); return n; },
      trocar: async (k, de, c) => trocarMapa(t.lanc, k, de, c),
    },
    regras: {
      listar: async (id) => copia(t.regras.filter((r) => String(r.id_condominio) === String(id) && r.ativo !== false)),
      salvar: async (l) => { t.regras = t.regras.filter((r) => !(String(r.id_condominio) === String(l.id_condominio) && r.padrao === l.padrao && Number(r.sinal) === Number(l.sinal))); t.regras.push(copia(l)); },
    },
    avisos: {
      gravarDia: async (dia, linhas) => { t.avisos = t.avisos.filter((a) => a.dia !== dia).concat(copia(linhas)); },
      listar: async (dia, ids) => copia(t.avisos.filter((a) => a.dia === dia && (!ids || lista(ids).includes(String(a.id_condominio))))),
      ultimoDia: async () => t.avisos.reduce((m, a) => (a.dia > m ? a.dia : m), '') || null,
    },
    estado: {
      salvar: async (l) => { t.estado.set(String(l.id_condominio), Object.assign(t.estado.get(String(l.id_condominio)) || {}, copia(l))); },
      listar: async (ids) => copia([...t.estado.values()].filter((e) => !ids || lista(ids).includes(String(e.id_condominio)))),
    },
  };
}

module.exports = { criarArmazemSupabase, criarArmazemMemoria };
