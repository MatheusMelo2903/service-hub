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

function validateAndPreview() {
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
    if (!obj.ID_CONTATO_CON || isNaN(Number(obj.ID_CONTATO_CON)))
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

  filtered.forEach(r => {
    const badge = r._valido
      ? '<span class="badge badge-ok">✓ ok</span>'
      : `<span class="badge badge-err">✕ ${r._erros.join('; ')}</span>`;
    html += `<tr>
      <td>${r._row}</td>
      <td class="${!r.ID_CONTATO_CON ? 'field-err' : ''}">${r.ID_CONTATO_CON || '—'}</td>
      <td class="${r._erros.some(e=>e.includes('Data')) ? 'field-err' : ''}">${r.DT_VENCIMENTO_PDES || '—'}</td>
      <td class="${r._erros.some(e=>e.includes('Valor')) ? 'field-err' : ''}">${r.VL_VALOR_PDES ? 'R$ ' + r.VL_VALOR_PDES : '—'}</td>
      <td class="${!r.ST_CONTA_CONT ? 'field-warn' : ''}">${r.ST_CONTA_CONT || '—'}</td>
      <td>${r.ST_DESCRICAO || '—'}</td>
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

  const btn = document.getElementById('btn-enviar');
  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';

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
      const body = new URLSearchParams({
        ID_CONDOMINIO_COND: condId,
        ID_CONTATO_CON: row.ID_CONTATO_CON,
        DT_VENCIMENTO_PDES: row.DT_VENCIMENTO_PDES,
        VL_VALOR_PDES: row.VL_VALOR_PDES,
        'DESPESA_APROPRIACAO[0][ST_CONTA_CONT]': row.ST_CONTA_CONT,
        'DESPESA_APROPRIACAO[0][VL_VALOR_DES]': row.VL_VALOR_PDES,
      });

      if (row.ST_NOME_CON) body.set('ST_NOME_CON', row.ST_NOME_CON);
      if (row.ST_DESCRICAO) body.set('DESPESA_APROPRIACAO[0][ST_DESCRICAO_CONT]', row.ST_DESCRICAO);

      const res = await apiPost('/despesas/', body.toString());
      if (res.ok) {
        ok++;
        addLog(logDiv, `linha ${row._row}: enviado ✓`, 'ok');
      } else {
        const txt = await res.text();
        err++;
        addLog(logDiv, `linha ${row._row}: erro ${res.status} — ${txt.slice(0,80)}`, 'err');
      }
    } catch(e) {
      err++;
      addLog(logDiv, `linha ${row._row}: ${e.message}`, 'err');
    }

    // Pequena pausa para não sobrecarregar a API
    if (i < validos.length - 1) await sleep(200);
  }

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

