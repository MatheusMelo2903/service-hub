// ============================================================
// SEGURANÇA (T16): só para quem tem a auditoria. Alertas de uso indevido, registro de
// tudo que cada pessoa fez e as transcrições (ver, baixar e apagar).
// Também: trocar senha e bloquear usuário na lista de Configurações.
// ============================================================

function segPodeVer() {
  const a = (window.USER_PERMS && window.USER_PERMS.configuracoes && window.USER_PERMS.configuracoes.acoes) || [];
  return a.includes('ver_auditoria') || a.includes('auditoria_total');
}
function segAtualizarMenu() {
  const n = document.getElementById('nav-seguranca');
  if (n) n.style.display = segPodeVer() ? '' : 'none';
}
const _segEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _segData = (d) => { try { return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch (e) { return String(d || ''); } };

function segAba(qual) {
  ['alertas', 'registro', 'transcricoes'].forEach((k) => {
    const el = document.getElementById('seg-' + k);
    if (el) el.style.display = k === qual ? '' : 'none';
    const b = document.getElementById('seg-tab-' + k);
    if (b) b.classList.toggle('active', k === qual);
  });
  if (qual === 'alertas') segCarregarAlertas();
  if (qual === 'registro') segCarregarRegistro();
  if (qual === 'transcricoes') segCarregarTranscricoes();
}
function segAbrir() { if (!segPodeVer()) return; segAba('alertas'); }

async function segCarregarAlertas() {
  const box = document.getElementById('seg-alertas-lista');
  box.innerHTML = '<div class="hint">Carregando...</div>';
  try {
    const r = await apiAuthFetch('/api/seguranca/alertas');
    const j = await r.json();
    if (!r.ok) throw new Error(j.detalhe || r.status);
    if (!j.alertas.length) { box.innerHTML = '<div class="hint">Nenhum alerta nos últimos 30 dias.</div>'; return; }
    box.innerHTML = j.alertas.map((a) => `<div style="background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--warning);border-radius:8px;padding:10px 12px;margin-bottom:8px">
      <div style="font-size:13px;color:var(--text);font-weight:600">${_segEsc(a.titulo)}${a.vezes > 1 ? ' <span style="color:var(--muted);font-weight:400">(' + a.vezes + ' vezes)</span>' : ''}</div>
      <div style="font-size:12px;color:var(--muted);font-family:var(--mono);margin-top:3px">${_segEsc(a.email || 'sem usuário')} · última em ${_segData(a.ultima)}${a.condominio ? ' · ' + _segEsc(a.condominio) : ''}</div>
      ${a.transcricao_id ? `<button class="btn btn-ghost" style="font-size:11px;padding:4px 8px;margin-top:6px" onclick="segVerTranscricao('${_segEsc(a.transcricao_id)}')">Ver transcrição</button>` : ''}
      ${(a.exemplos || []).length ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">' + a.exemplos.map((e) => _segData(e.em) + ': ' + _segEsc(e.acao) + (e.id_superlogica ? ' (cond. ' + e.id_superlogica + ')' : '') + (e.resumo ? ' ' + _segEsc(e.resumo) : '')).join('<br>') + '</div>' : ''}
    </div>`).join('');
  } catch (e) { box.innerHTML = '<div class="hint" style="color:var(--danger)">Falha ao carregar: ' + _segEsc(e.message) + '</div>'; }
}

async function segCarregarRegistro() {
  const box = document.getElementById('seg-registro-lista');
  const q = new URLSearchParams();
  const pessoa = (document.getElementById('seg-f-pessoa') || {}).value || '';
  const de = (document.getElementById('seg-f-de') || {}).value || '';
  const ate = (document.getElementById('seg-f-ate') || {}).value || '';
  if (pessoa.trim()) q.set('pessoa', pessoa.trim());
  if (de) q.set('de', de);
  if (ate) q.set('ate', ate);
  if ((document.getElementById('seg-f-suspeito') || {}).checked) q.set('suspeito', '1');
  box.innerHTML = '<div class="hint">Carregando...</div>';
  try {
    const r = await apiAuthFetch('/api/seguranca/registro?' + q.toString());
    const j = await r.json();
    if (!r.ok) throw new Error(j.detalhe || r.status);
    if (!j.itens.length) { box.innerHTML = '<div class="hint">Nada encontrado.</div>'; return; }
    // Email e acao com motivo quebram em ate 2 linhas (td-livre no index.html): motivo longo alargava o cartao
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg3)"><th style="text-align:left;padding:6px">Quando</th><th style="text-align:left;padding:6px">Quem</th><th style="text-align:left;padding:6px">O quê</th><th style="text-align:left;padding:6px">Cond.</th><th style="text-align:left;padding:6px">Resultado</th></tr></thead><tbody>' +
      j.itens.map((i) => `<tr style="border-bottom:1px solid var(--border);${i.suspeito ? 'background:rgba(245,166,35,0.08)' : ''}">
        <td style="padding:6px;white-space:nowrap">${_segData(i.criado_em)}</td>
        <td class="td-livre" style="padding:6px" title="${_segEsc(i.email || '')}"><div class="td-2l">${_segEsc(i.email || '')}</div></td>
        <td class="td-livre" style="padding:6px;font-family:var(--mono)" title="${_segEsc(i.acao + (i.motivo ? ' (' + i.motivo + ')' : ''))}"><div class="td-2l">${_segEsc(i.acao)}${i.motivo ? ' <span style="color:var(--warning)">(' + _segEsc(i.motivo) + ')</span>' : ''}</div></td>
        <td style="padding:6px">${i.id_superlogica || ''}</td>
        <td style="padding:6px">${i.status || ''}${i.ip ? ' <span style="color:var(--muted)">' + _segEsc(i.ip) + '</span>' : ''}</td></tr>`).join('') + '</tbody></table>';
  } catch (e) { box.innerHTML = '<div class="hint" style="color:var(--danger)">Falha ao carregar: ' + _segEsc(e.message) + '</div>'; }
}

async function segCarregarTranscricoes() {
  const box = document.getElementById('seg-transcricoes-lista');
  box.innerHTML = '<div class="hint">Carregando...</div>';
  try {
    const r = await apiAuthFetch('/api/seguranca/transcricoes');
    const j = await r.json();
    if (!r.ok) throw new Error(j.detalhe || r.status);
    if (!j.itens.length) { box.innerHTML = '<div class="hint">Nenhuma transcrição ainda.</div>'; return; }
    const ORIG = { audio: 'áudio', arquivo_txt: 'arquivo .txt', colada: 'texto colado', editada: 'texto corrigido' };
    box.innerHTML = j.itens.map((t) => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:6px">
      <div style="flex:1;min-width:220px">
        <div style="font-size:13px;color:var(--text)">${_segEsc(t.condominio_nome || 'SEM CONDOMÍNIO')} <span style="color:var(--muted);font-size:11px">(${_segEsc(ORIG[t.origem] || t.origem)})</span></div>
        <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">${_segEsc(t.email || '')} · ${_segData(t.criado_em)} · ${Number(t.caracteres || 0).toLocaleString('pt-BR')} caracteres · ${t.usada_em_ata ? 'virou ata' : 'sem ata'}${t.apagada_em ? ' · apagada' : ''}</div>
      </div>
      ${t.apagada_em ? '' : `<button class="btn btn-ghost" style="font-size:11px;padding:4px 8px" onclick="segVerTranscricao('${_segEsc(t.id)}')">Ver</button>
      ${window.USER_DONO === true ? `<button class="btn btn-ghost" style="font-size:11px;padding:4px 8px;color:var(--danger)" onclick="segApagarTranscricao('${_segEsc(t.id)}')">Apagar texto</button>` : ''}`}
    </div>`).join('');
  } catch (e) { box.innerHTML = '<div class="hint" style="color:var(--danger)">Falha ao carregar: ' + _segEsc(e.message) + '</div>'; }
}

let _segTextoAberto = null;
async function segVerTranscricao(id) {
  try {
    const r = await apiAuthFetch('/api/seguranca/transcricoes/' + encodeURIComponent(id));
    const j = await r.json();
    if (!r.ok) throw new Error(j.detalhe || r.status);
    _segTextoAberto = j;
    document.getElementById('seg-modal-titulo').textContent = (j.condominio || 'Sem condomínio') + ' · ' + (j.email || '') + ' · ' + _segData(j.criado_em);
    document.getElementById('seg-modal-texto').value = j.apagada ? '(texto apagado)' : j.texto;
    document.getElementById('seg-modal').style.display = 'flex';
  } catch (e) { toast('Não foi possível abrir: ' + e.message, 'err'); }
}
function segFecharModal() { document.getElementById('seg-modal').style.display = 'none'; _segTextoAberto = null; }
function segBaixarTranscricao() {
  if (!_segTextoAberto || !_segTextoAberto.texto) return;
  const blob = new Blob([_segTextoAberto.texto], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'transcricao-' + String(_segTextoAberto.condominio || 'sem-condominio').replace(/[^a-z0-9]+/gi, '_') + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function segApagarTranscricao(id) {
  if (!confirm('Apagar o texto desta transcrição? O registro de que ela existiu continua.')) return;
  const r = await apiAuthFetch('/api/seguranca/transcricoes/' + encodeURIComponent(id), { method: 'DELETE' });
  if (r.ok) { toast('Texto apagado', 'ok'); segCarregarTranscricoes(); } else toast('Não foi possível apagar', 'err');
}

// ---------- Controles de usuário (lista em Configurações) ----------
function adminTrocarSenha(id, email) {
  const m = document.getElementById('modal-admin-senha');
  m.dataset.alvo = id;
  document.getElementById('admin-senha-email').textContent = email;
  document.getElementById('admin-senha-1').value = '';
  document.getElementById('admin-senha-2').value = '';
  document.getElementById('admin-senha-erro').textContent = '';
  m.style.display = 'flex';
}
function adminFecharSenha() { document.getElementById('modal-admin-senha').style.display = 'none'; }
async function adminSalvarSenha() {
  const m = document.getElementById('modal-admin-senha');
  const s1 = document.getElementById('admin-senha-1').value;
  const s2 = document.getElementById('admin-senha-2').value;
  const err = document.getElementById('admin-senha-erro');
  if (s1.length < 8) { err.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
  if (s1 !== s2) { err.textContent = 'As duas senhas não estão iguais.'; return; }
  const r = await apiAuthFetch('/api/admin/usuarios/' + encodeURIComponent(m.dataset.alvo) + '/senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: s1 }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { err.textContent = j.detalhe || 'Não foi possível trocar a senha.'; return; }
  adminFecharSenha();
  toast('Senha trocada', 'ok');
}
async function adminBloquear(id, email, bloquear) {
  if (!confirm((bloquear ? 'Bloquear ' : 'Desbloquear ') + email + '?' + (bloquear ? ' A pessoa sai do sistema na hora e não entra mais até você desbloquear.' : ''))) return;
  const r = await apiAuthFetch('/api/admin/usuarios/' + encodeURIComponent(id) + '/bloqueio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bloquear }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.detalhe || 'Não foi possível', 'err'); return; }
  toast(bloquear ? 'Usuário bloqueado' : 'Usuário desbloqueado', 'ok');
  if (typeof carregarUsuarios === 'function') carregarUsuarios();
}
