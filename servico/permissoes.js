// T21: quem pode mexer em quem, e o quê.
// Dono (configuracoes.auditoria_total, dado só pelo banco): pode tudo, menos tirar o próprio
// acesso de dono. Ver chaves e ver auditoria só o dono dá ou tira.
// Os outros (GESTOR que não é dono, GERENTE que pode convidar) mexem no que eles mesmos
// têm e no que o dono deixou cada um liberar ("concede": { modulo: [acoes] }, com 'ver'
// valendo também para mostrar o módulo). Nunca mexem em GESTOR, no dono, em si mesmos, em quem tem ação
// restrita nem em quem também pode liberar acessos.

// todas_carteiras (T18, ver todas as carteiras) também: só o dono dá ou tira, nunca vai no concede.
const RESTRITAS = ['ver_chaves', 'ver_auditoria', 'auditoria_total', 'todas_carteiras'];
const NOME = /^[a-z_]{1,40}$/;

const acoesDe = (perms, m) => {
  const x = perms && perms[m];
  return x && Array.isArray(x.acoes) ? x.acoes : [];
};
const visivel = (perms, m) => !!(perms && perms[m] && perms[m].visivel === true);
const ehDono = (p) => acoesDe(p && p.permissoes, 'configuracoes').includes('auditoria_total');
const temRestrita = (p) => RESTRITAS.some((a) => Object.keys((p && p.permissoes) || {}).some((m) => acoesDe(p.permissoes, m).includes(a)));
const temConcede = (p) => !!(p && p.concede && Object.values(p.concede).some((l) => Array.isArray(l) && l.length));

// Pode editar (permissões, senha, bloqueio, exclusão) este alvo?
function podeEditarAlvo(editor, alvo, interno) {
  if (interno) return { ok: true };
  if (!editor || !alvo) return { ok: false, motivo: 'sem_perfil' };
  if (editor.id && alvo.id && editor.id === alvo.id) return { ok: false, motivo: 'proprio_usuario' };
  if (ehDono(alvo)) return { ok: false, motivo: 'alvo_dono' };
  if (ehDono(editor)) return { ok: true };
  if (alvo.role === 'GESTOR') return { ok: false, motivo: 'alvo_gestor' };
  if (temRestrita(alvo) || temConcede(alvo)) return { ok: false, motivo: 'alvo_protegido' };
  if (editor.role === 'GERENTE' && alvo.role !== 'OPERACIONAL') return { ok: false, motivo: 'gerente_so_operacional' };
  if (editor.role !== 'GESTOR' && !(editor.role === 'GERENTE' && editor.pode_convidar === true)) return { ok: false, motivo: 'sem_gestao' };
  return { ok: true };
}

// Confere a mudança de permissões. Devolve { ok, motivo, adicionadas, removidas }.
function conferirMudanca(editor, antes, depois, interno) {
  const adicionadas = []; const removidas = [];
  const mods = new Set(Object.keys(antes || {}).concat(Object.keys(depois || {})));
  mods.forEach((m) => {
    if (visivel(antes, m) !== visivel(depois, m)) (visivel(depois, m) ? adicionadas : removidas).push(m + '.ver');
    const a = acoesDe(antes, m); const d = acoesDe(depois, m);
    d.filter((x) => !a.includes(x)).forEach((x) => adicionadas.push(m + '.' + x));
    a.filter((x) => !d.includes(x)).forEach((x) => removidas.push(m + '.' + x));
  });
  const mexidas = adicionadas.concat(removidas);
  if (mexidas.some((x) => x.endsWith('.auditoria_total'))) return { ok: false, motivo: 'acesso_de_dono', adicionadas, removidas };
  if (interno) return { ok: true, adicionadas, removidas };
  if (ehDono(editor)) return { ok: true, adicionadas, removidas };
  if (mexidas.some((x) => RESTRITAS.includes(x.split('.')[1]))) return { ok: false, motivo: 'acesso_restrito', adicionadas, removidas };
  const concede = (editor && editor.concede) || {};
  // 23/10/2026 (pedido do Matheus): quem gerencia usuários também repassa o que ele mesmo
  // tem. Módulo visível para ele libera "ver"; cada ação que ele tem libera a mesma ação.
  // O "concede" que o dono marcar continua valendo como liberação extra.
  const minhas = (editor && editor.permissoes) || {};
  const euTenho = (m, a) => (a === 'ver' ? visivel(minhas, m) : (visivel(minhas, m) && acoesDe(minhas, m).includes(a)));
  const fora = mexidas.filter((x) => { const [m, a] = x.split('.'); return !((Array.isArray(concede[m]) && concede[m].includes(a)) || euTenho(m, a)); });
  if (fora.length) return { ok: false, motivo: 'fora_do_que_pode_liberar', fora, adicionadas, removidas };
  return { ok: true, adicionadas, removidas };
}

// Formato do "concede" que o dono grava para alguém.
function concedeBemFormado(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  return Object.entries(c).every(([m, l]) => NOME.test(m) && Array.isArray(l) && l.length <= 20
    && l.every((a) => typeof a === 'string' && NOME.test(a) && !RESTRITAS.includes(a)));
}

module.exports = { RESTRITAS, ehDono, temRestrita, temConcede, podeEditarAlvo, conferirMudanca, concedeBemFormado };
