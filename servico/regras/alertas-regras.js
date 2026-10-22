// Regras do condomínio: alertas somados aos alertas do condomínio (mesma tabela `alertas`,
// mesmo painel). Formato igual ao de superlogica/alertas-operacionais.js: chave estável, tipo,
// título e detalhe.resumo pronto para a tela (detalhe.gravidade também, para quem quiser cor).
//  1. Mandato de síndico ou de conselho vencido ou vencendo em até 60 dias (só o mandato atual
//     de cada cargo: se já existe um mais novo, o antigo não alerta).
//  2. Advertência registrada com prazo de regularização vencido e ainda sem regularizar
//     (sugere avaliar a multa prevista no regimento).
// Só lê o banco (regras_mandatos e regras_notificacoes); nada no Superlógica.

const enc = encodeURIComponent;
const DIAS_AVISO = 60;
const DIA_MS = 86400000;
const NOME_CARGO = { sindico: 'síndico', conselho_fiscal: 'conselho fiscal', conselho_consultivo: 'conselho consultivo', conselho: 'conselho' };

const pad = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const br = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; };
const diasEntre = (deIso, ateIso) => Math.round((Date.parse(ateIso + 'T00:00:00Z') - Date.parse(deIso + 'T00:00:00Z')) / DIA_MS);

// Mandatos atuais (início mais recente por cargo) com fim até hoje + 60 dias. Os membros do
// mesmo conselho com o mesmo fim viram um alerta só.
function alertasMandatos(mandatos, hojeIso) {
  const porCargo = new Map();
  (mandatos || []).forEach((m) => {
    if (!NOME_CARGO[m.cargo]) return; // subsíndico não alerta (pedido: síndico e conselho)
    if (!porCargo.has(m.cargo)) porCargo.set(m.cargo, []);
    porCargo.get(m.cargo).push(m);
  });
  const out = [];
  porCargo.forEach((lista, cargo) => {
    const inicioAtual = lista.reduce((mx, m) => (m.inicio && m.inicio > mx ? m.inicio : mx), '');
    const atuais = lista.filter((m) => (m.inicio || '') === inicioAtual && m.fim);
    const porFim = new Map();
    atuais.forEach((m) => { if (!porFim.has(m.fim)) porFim.set(m.fim, []); porFim.get(m.fim).push(m); });
    porFim.forEach((ms, fim) => {
      const dias = diasEntre(hojeIso, fim);
      if (dias > DIAS_AVISO) return;
      const vencido = dias < 0;
      const nomes = ms.map((m) => m.nome).filter(Boolean);
      const quem = NOME_CARGO[cargo];
      out.push({
        // estado na chave: quem marcou "vencendo" como resolvido volta a ver quando vencer
        chave: 'mandato:' + cargo + ':' + fim + ':' + (vencido ? 'vencido' : 'vencendo'),
        tipo: 'mandato_vencendo',
        titulo: vencido ? 'Mandato do ' + quem + ' venceu em ' + br(fim) : 'Mandato do ' + quem + ' vence em ' + br(fim),
        detalhe: {
          gravidade: vencido ? 'alta' : 'media', cargo, fim: br(fim), inicio: br(ms[0].inicio), dias,
          nomes, conferido: ms.every((m) => m.conferido), mandatos: ms.map((m) => m.id),
          resumo: (nomes.length ? nomes.slice(0, 5).join(', ') + (nomes.length > 5 ? ' e mais ' + (nomes.length - 5) : '') + '; ' : '')
            + (vencido ? 'vencido há ' + Math.abs(dias) + ' dia' + (Math.abs(dias) === 1 ? '' : 's') : 'faltam ' + dias + ' dia' + (dias === 1 ? '' : 's'))
            + '; programar a assembleia de eleição' + (ms.every((m) => m.conferido) ? '' : ' (datas tiradas da ata, conferir na aba Mandatos)'),
        },
      });
    });
  });
  return out;
}

// Advertências registradas com prazo vencido e sem regularizar.
function alertasAdvertencias(notificacoes, hojeIso) {
  return (notificacoes || []).filter((n) => n.tipo === 'advertencia' && n.status === 'registrada' && n.prazo_regularizacao && n.prazo_regularizacao < hojeIso)
    .map((n) => {
      const dias = diasEntre(n.prazo_regularizacao, hojeIso);
      const unidade = [n.bloco, n.unidade].filter(Boolean).join(' ') || 'unidade';
      return {
        chave: 'advertencia_vencida:' + n.id + ':' + n.prazo_regularizacao,
        tipo: 'advertencia_vencida',
        titulo: 'Advertência da unidade ' + unidade + ' com prazo vencido em ' + br(n.prazo_regularizacao),
        detalhe: {
          gravidade: 'media', notificacao_id: n.id, unidade, prazo: br(n.prazo_regularizacao), dias,
          ocorrencia: String(n.ocorrencia || '').slice(0, 200),
          resumo: (n.ocorrencia ? String(n.ocorrencia).slice(0, 120) + '; ' : '') + 'prazo vencido há ' + dias + ' dia' + (dias === 1 ? '' : 's')
            + ' sem regularizar; avaliar a multa prevista no regimento',
        },
      };
    });
}

// deps: { banco } (ou a própria função banco). hoje: Date local (como nos outros alertas).
// Devolve { alertas, falhas }, igual a calcularOperacionais, para somar com concat.
async function gerarAlertasRegras(deps, idSL, hoje) {
  const banco = typeof deps === 'function' ? deps : deps.banco;
  const h = hoje instanceof Date ? hoje : new Date();
  const hojeIso = isoLocal(h);
  const falhas = [];
  const [m, n] = await Promise.all([
    banco('GET', '/rest/v1/regras_mandatos?id_superlogica=eq.' + enc(idSL) + '&select=id,cargo,nome,inicio,fim,conferido&order=inicio.desc.nullslast&limit=300').catch(() => null),
    banco('GET', '/rest/v1/regras_notificacoes?id_superlogica=eq.' + enc(idSL) + '&tipo=eq.advertencia&status=eq.registrada&prazo_regularizacao=lt.' + hojeIso
      + '&select=id,tipo,status,unidade,bloco,ocorrencia,prazo_regularizacao&order=prazo_regularizacao.asc&limit=200').catch(() => null),
  ]);
  let alertas = [];
  if (m && m.status === 200 && Array.isArray(m.body)) alertas = alertas.concat(alertasMandatos(m.body, hojeIso));
  else falhas.push('mandatos');
  if (n && n.status === 200 && Array.isArray(n.body)) alertas = alertas.concat(alertasAdvertencias(n.body, hojeIso));
  else falhas.push('advertências');
  return { alertas, falhas };
}

module.exports = { gerarAlertasRegras, alertasMandatos, alertasAdvertencias, DIAS_AVISO };
