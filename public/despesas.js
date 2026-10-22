// ============================================================
// IMPORTAR DESPESAS: extraído de public/index.html (T02, só movido, sem mudar
// comportamento). Script clássico: funções e variáveis seguem globais,
// no mesmo escopo do script inline do index.html.
// ============================================================

// ============================================================
// MAPPER DE COLUNAS
// ============================================================
function buildMapper() {
  const container = document.getElementById('mapper-despesas');
  const headers = state.despesas.headers;
  const opts = ['(ignorar)', ...headers];

  let html = '';
  CAMPOS_DESPESA.forEach(campo => {
    const bestGuess = headers.findIndex(h => {
      const hl = h.toLowerCase();
      const kl = campo.key.toLowerCase();
      return hl.includes(campo.label.toLowerCase().split(' ')[0]) ||
             hl.includes(kl.replace(/_/g,' ').split(' ').pop());
    });

    const selected = (i) => i === bestGuess + 1 ? 'selected' : '';

    html += `
      <div class="mapper-grid">
        <div style="text-align:right">
          <div style="font-size:13px;color:var(--text)">${campo.label}</div>
          <div style="font-size:10px;font-family:var(--mono);color:var(--muted)">${campo.required ? '* obrigatório' : 'opcional'}</div>
        </div>
        <div class="mapper-arrow">→</div>
        <select id="map-${campo.key}" style="width:100%">
          ${opts.map((o, i) => `<option value="${i === 0 ? '' : o}" ${selected(i)}>${o}</option>`).join('')}
        </select>
      </div>`;
  });

  container.innerHTML = html;
}

// ============================================================
// VALIDAÇÃO
// ============================================================
function goToMapping() {
  if (!state.despesas.raw.length) { toast('Carregue uma planilha primeiro', 'err'); return; }
  setTabByName('tab-mapeamento');
}

// ============================================================
// CHECAGEM NO SUPERLÓGICA ANTES DO ENVIO (T05)
// Duplicata (mesmo fornecedor, valor, vencimento e documento, já lançada no Superlógica ou
// repetida na planilha) e fornecedor que não existe. Linha com problema fica bloqueada.
// ============================================================
async function despesasVerificarNoSuperlogica(linhas) {
  const cond = getCondominioAtivo();
  if (!cond || !cond.id_superlogica) throw new Error('Selecione um condomínio com código do Superlógica');
  const r = await apiAuthFetch('/api/despesas/verificar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id_superlogica: cond.id_superlogica,
      linhas: linhas.map(l => ({ linha: l._row, fornecedor_id: l.ID_CONTATO_CON, vencimento: l.DT_VENCIMENTO_PDES, valor: l.VL_VALOR_PDES, documento: l.ST_DOCUMENTO_DES || '' })),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detalhe || ('Falha ' + r.status));
  return j;
}

// Marca nas linhas o resultado da checagem. Devolve quantas ficaram bloqueadas.
function despesasAplicarChecagem(rows, chk) {
  const porLinha = new Map(rows.map(r => [r._row, r]));
  let bloqueadas = 0;
  const add = (r, msg) => { if (!r._erros.includes(msg)) r._erros.push(msg); };
  (chk.duplicadas || []).forEach(d => {
    const r = porLinha.get(d.linha); if (!r) return;
    add(r, d.origem === 'planilha'
      ? 'Repetida na planilha (igual à linha ' + d.igual_a_linha + ')'
      : 'Já lançada no Superlógica (despesa ' + (d.id_despesa || '') + ', venc. ' + d.vencimento + (d.paga ? ', paga' : '') + ')');
    if (r._valido) bloqueadas++;
    r._valido = false;
  });
  (chk.fornecedor_inexistente || []).forEach(f => {
    const r = porLinha.get(f.linha); if (!r) return;
    add(r, 'Fornecedor ' + f.fornecedor_id + ' não existe no Superlógica');
    if (r._valido) bloqueadas++;
    r._valido = false;
  });
  return bloqueadas;
}

async function validateAndPreview() {
  const headers = state.despesas.headers;
  const rows = state.despesas.raw;

  const mapping = {};
  CAMPOS_DESPESA.forEach(c => {
    const sel = document.getElementById('map-' + c.key);
    if (sel && sel.value) mapping[c.key] = sel.value;
  });

  const required = CAMPOS_DESPESA.filter(c => c.required);
  const missingRequired = required.filter(c => !mapping[c.key]);
  if (missingRequired.length) {
    toast('Mapeie os campos obrigatórios: ' + missingRequired.map(c=>c.label).join(', '), 'err');
    return;
  }

  // Transformar e validar
  const validated = rows.map((row, idx) => {
    const obj = { _row: idx + 2, _erros: [] };

    CAMPOS_DESPESA.forEach(c => {
      if (mapping[c.key]) {
        const colIdx = headers.indexOf(mapping[c.key]);
        obj[c.key] = colIdx >= 0 ? String(row[colIdx] || '').trim() : '';
      }
    });

    // Validações
    if (!/^[1-9][0-9]{0,9}$/.test(obj.ID_CONTATO_CON || ''))
      obj._erros.push('ID fornecedor inválido');

    if (!obj.DT_VENCIMENTO_PDES) {
      obj._erros.push('Data vazia');
    } else {
      // Aceitar DD/MM/AAAA e converter para MM/DD/AAAA (formato API)
      const m = obj.DT_VENCIMENTO_PDES.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (m) {
        obj.DT_VENCIMENTO_PDES = m[2] + '/' + m[1] + '/' + m[3]; // DD/MM → MM/DD
      } else {
        obj._erros.push('Data inválida — use DD/MM/AAAA');
      }
    }

    if (!obj.VL_VALOR_PDES) {
      obj._erros.push('Valor vazio');
    } else {
      const v = parseFloat(obj.VL_VALOR_PDES.replace(',', '.'));
      if (isNaN(v) || v <= 0) obj._erros.push('Valor inválido');
      else obj.VL_VALOR_PDES = v.toFixed(2);
    }

    if (!obj.ST_CONTA_CONT) obj._erros.push('Conta plano vazia');

    obj._valido = obj._erros.length === 0;
    return obj;
  });

  // T05: confere no Superlógica as linhas que passaram na validação local
  const paraChecar = validated.filter(r => r._valido);
  if (paraChecar.length) {
    try {
      toast('Conferindo duplicatas e fornecedores no Superlógica...', 'info');
      const chk = await despesasVerificarNoSuperlogica(paraChecar);
      despesasAplicarChecagem(validated, chk);
    } catch (e) {
      toast('Não foi possível conferir no Superlógica: ' + e.message + '. O envio fica travado até conferir.', 'err');
      paraChecar.forEach(r => { r._erros.push('Não conferido no Superlógica'); r._valido = false; });
    }
  }

  state.despesas.validated = validated;

  const total = validated.length;
  const ok = validated.filter(r => r._valido).length;
  const err = total - ok;

  document.getElementById('env-total').textContent = total;
  document.getElementById('env-ok').textContent = ok;
  document.getElementById('env-err').textContent = err;

  renderValidatedTable(validated, 'todos');
  setTabByName('tab-envio');

  if (err > 0) toast(`${err} linha(s) com problema — corrija antes de enviar`, 'warn');
  else toast(`${ok} linhas válidas — pronto para enviar!`, 'ok');
}

// ============================================================
// TABELA VALIDADA
// ============================================================
function renderValidatedTable(rows, filter) {
  const filtered = filter === 'todos' ? rows
    : filter === 'ok' ? rows.filter(r => r._valido)
    : rows.filter(r => !r._valido);

  const table = document.getElementById('validated-table');
  let html = `<tr>
    <th>Linha</th><th>Fornecedor ID</th><th>Vencimento</th><th>Valor</th>
    <th>Conta</th><th>Descrição</th><th>Status</th>
  </tr>`;

  // Conteúdo da planilha vai escapado (planilha de terceiro não pode injetar HTML).
  const e = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  filtered.forEach(r => {
    const badge = r._valido
      ? '<span class="badge badge-ok">✓ ok</span>'
      : `<span class="badge badge-err">✕ ${e(r._erros.join('; '))}</span>`;
    html += `<tr>
      <td>${e(r._row)}</td>
      <td class="${!r.ID_CONTATO_CON ? 'field-err' : ''}">${e(r.ID_CONTATO_CON || '—')}</td>
      <td class="${r._erros.some(x=>x.includes('Data')) ? 'field-err' : ''}">${e(r.DT_VENCIMENTO_PDES || '—')}</td>
      <td class="${r._erros.some(x=>x.includes('Valor')) ? 'field-err' : ''}">${r.VL_VALOR_PDES ? 'R$ ' + e(r.VL_VALOR_PDES) : '—'}</td>
      <td class="${!r.ST_CONTA_CONT ? 'field-warn' : ''}">${e(r.ST_CONTA_CONT || '—')}</td>
      <td>${e(r.ST_DESCRICAO || '—')}</td>
      <td>${badge}</td>
    </tr>`;
  });

  table.innerHTML = html;
}

function filterRows(el, filter) {
  document.querySelectorAll('.chips .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderValidatedTable(state.despesas.validated, filter);
}

// ============================================================
// ENVIO PARA SUPERLÓGICA
// ============================================================
async function enviarDespesas() {
  if (!apiPronta()) { toast('Configure os tokens da API primeiro', 'err'); return; }
  // Proxy obrigatório para não tentar chamada CORS direta — usa getProxy() para valor sanitizado
  if (!getProxy()) { toast('Configure o proxy nas Configuracoes', 'err'); return; }

  const validos = state.despesas.validated.filter(r => r._valido);
  if (!validos.length) { toast('Nenhum registro válido para enviar', 'err'); return; }

  // Lê o condomínio ativo via getCondominioAtivo para garantir que id_superlogica (numérico)
  // seja usado como ID_CONDOMINIO_COND, nunca o UUID Supabase.
  const condAtivo = getCondominioAtivo();
  const condId = condAtivo ? (condAtivo.id_superlogica || condAtivo.id) : null;
  if (!condAtivo || !condAtivo.id_superlogica) {
    toast('Selecione um condomínio com ID Superlógica antes de enviar', 'err');
    return;
  }

  // T48: grava despesas no cliente; confirma condomínio, quantidade e total antes.
  const totalCent = validos.reduce((s, r) => s + (Math.round(parseFloat(r.VL_VALOR_PDES) * 100) || 0), 0);
  const totalTxt = totalCent ? ', total R$ ' + (totalCent / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  if (!confirm('Lançar ' + validos.length + ' despesa(s)' + totalTxt + ' no Superlógica, condomínio ' + (condAtivo.nome || condAtivo.nome_fantasia || '') + ' (código ' + condAtivo.id_superlogica + ')?')) return;

  const btn = document.getElementById('btn-enviar');
  btn.disabled = true;
  btn.textContent = '⏳ Conferindo...';
  // T05: confere de novo logo antes de enviar (alguém pode ter lançado nesse meio tempo).
  // Qualquer duplicata ou fornecedor inexistente TRAVA o envio inteiro.
  try {
    const chk = await despesasVerificarNoSuperlogica(validos);
    if (!chk.pode_enviar) {
      const n = despesasAplicarChecagem(state.despesas.validated, chk);
      renderValidatedTable(state.despesas.validated, 'todos');
      const okAgora = state.despesas.validated.filter(r => r._valido).length;
      document.getElementById('env-ok').textContent = okAgora;
      document.getElementById('env-err').textContent = state.despesas.validated.length - okAgora;
      btn.disabled = false; btn.textContent = '↑ Enviar para Superlógica';
      toast('Envio travado: ' + n + ' linha(s) duplicada(s) ou com fornecedor inexistente. Revise e envie de novo.', 'err');
      return;
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = '↑ Enviar para Superlógica';
    toast('Envio travado: não foi possível conferir duplicatas no Superlógica (' + e.message + ').', 'err');
    return;
  }
  btn.textContent = '⏳ Enviando...';
  // Trava a troca de condomínio durante o envio (condTrocaBloqueada)
  window._enviandoDespesas = true;

  const progressWrap = document.getElementById('send-progress-wrap');
  const progressBar = document.getElementById('send-progress');
  const logDiv = document.getElementById('send-log');
  progressWrap.style.display = 'block';
  logDiv.style.display = 'block';
  logDiv.innerHTML = '';

  let ok = 0, err = 0;

  for (let i = 0; i < validos.length; i++) {
    const row = validos[i];
    const pct = Math.round(((i + 1) / validos.length) * 100);
    progressBar.style.width = pct + '%';

    try {
      // T05: campos conforme a documentação do POST despesas (os nomes antigos,
      // DT_VENCIMENTO_PDES e DESPESA_APROPRIACAO, eram recusados com "Nenhuma parcela enviada"
      // e o Superlógica respondia 206; a tela contava como enviado sem criar nada).
      const body = new URLSearchParams({
        ID_CONDOMINIO_COND: condId,
        ID_CONTATO_CON: row.ID_CONTATO_CON,
        DT_VENCIMENTOPRIMEIRAPARCELA: row.DT_VENCIMENTO_PDES,
        ID_FORMA_PAG: '0',
        'APROPRIACAO[0][ST_CONTA_CONT]': row.ST_CONTA_CONT,
        'APROPRIACAO[0][VL_VALOR_PDES]': row.VL_VALOR_PDES,
      });

      if (row.ST_NOME_CON) body.set('ST_NOME_CON', row.ST_NOME_CON);
      if (row.ST_DESCRICAO) body.set('APROPRIACAO[0][ST_COMPLEMENTO_APRO]', row.ST_DESCRICAO);
      if (row.ST_DOCUMENTO_DES) body.set('ST_DOCUMENTO_DES', row.ST_DOCUMENTO_DES);

      const res = await apiPost('/despesas/', body.toString());
      const txt = await res.text();
      // Sucesso só quando o próprio corpo diz status 200 (o HTTP pode vir 200 ou 206 com erro dentro).
      let item = null;
      try { const j = JSON.parse(txt); item = Array.isArray(j) ? j[0] : j; } catch (_) { item = null; }
      const criado = res.ok && item && String(item.status) === '200' && item.data && item.data.id_despesa_des;
      if (criado) {
        ok++;
        addLog(logDiv, `linha ${row._row}: enviado ✓ (despesa ${item.data.id_despesa_des})`, 'ok');
      } else {
        err++;
        const msg = item && item.msg ? String(item.msg) : txt.slice(0, 80);
        addLog(logDiv, `linha ${row._row}: erro ${res.status}: ${msg.slice(0, 120)}`, 'err');
      }
    } catch(e) {
      err++;
      addLog(logDiv, `linha ${row._row}: ${e.message}`, 'err');
    }

    // Pequena pausa para não sobrecarregar a API
    if (i < validos.length - 1) await sleep(200);
  }

  window._enviandoDespesas = false;
  btn.disabled = false;
  btn.textContent = '↑ Enviar para Superlógica';

  state.stats.imports++;
  state.stats.records += ok;
  state.stats.errors += err;
  document.getElementById('stat-imports').textContent = state.stats.imports;
  document.getElementById('stat-records').textContent = state.stats.records;
  document.getElementById('stat-errors').textContent = state.stats.errors;

  addHistorico(`Despesas: ${ok} enviadas, ${err} erros`);

  if (err === 0) toast(`${ok} despesas enviadas com sucesso! ✓`, 'ok');
  else toast(`${ok} enviadas, ${err} com erro — veja o log`, 'warn');
}

// Trocou de condomínio (T02): a planilha carregada era para o anterior. Descarta e volta ao passo 1.
window.addEventListener('condominioAtivo:trocou', function() {
  var d = state.despesas;
  var tinha = (d.raw && d.raw.length) || (d.validated && d.validated.length);
  d.raw = []; d.headers = []; d.mapped = []; d.validated = [];
  var prev = document.getElementById('preview-despesas');
  if (prev) prev.style.display = 'none';
  ['validated-table', 'despesas-table', 'mapper-despesas'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.innerHTML = '';
  });
  var log = document.getElementById('send-log');
  if (log) { log.innerHTML = ''; log.style.display = 'none'; }
  var pw = document.getElementById('send-progress-wrap');
  if (pw) pw.style.display = 'none';
  ['env-total', 'env-ok', 'env-err'].forEach(function(id) { var el = document.getElementById(id); if (el) el.textContent = '0'; });
  var painel = document.getElementById('panel-despesas');
  if (painel) {
    painel.querySelectorAll('.tabs .tab').forEach(function(t, i) { t.classList.toggle('active', i === 0); });
    setTabByName('tab-upload');
  }
  if (tinha) toast('Planilha de despesas descartada: o condomínio mudou.', 'info');
});
