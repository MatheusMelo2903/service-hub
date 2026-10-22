// Regras do condomínio: confere se uma citação existe de verdade no texto do trecho.
// Regra anti invenção (a mesma ideia da ata): toda resposta, carta, comunicado ou aviso que
// cita convenção, regimento ou ata só mostra a citação se o trecho literal estiver no acervo.
// Comparação sem acento, sem caixa, sem pontuação e com espaços colapsados (o OCR e o modelo
// costumam mexer em vírgula, aspas e quebra de linha, nunca no conteúdo).

const normalizar = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9%$]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// A citação está no texto? Aceita reticências no meio ("início ... fim") como dois pedaços em ordem.
function citacaoExiste(citacao, texto) {
  const alvo = normalizar(texto);
  const partes = String(citacao || '').split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/).map(normalizar).filter((p) => p.length >= 3);
  if (!partes.length || !alvo) return false;
  let pos = 0;
  for (const p of partes) {
    const i = alvo.indexOf(p, pos);
    if (i < 0) return false;
    pos = i + p.length;
  }
  return true;
}

// Confere uma lista de fundamentos { trecho_id, citacao } contra os trechos que foram dados
// ao modelo (Map id -> trecho). Devolve os aprovados (com rótulo e documento do acervo, nunca
// os do modelo) e os recusados (para log e aviso na tela).
function conferirFundamentos(fundamentos, trechosPorId) {
  const aprovados = [];
  const recusados = [];
  (Array.isArray(fundamentos) ? fundamentos : []).forEach((f) => {
    const t = f && trechosPorId.get(Number(f.trecho_id));
    const citacao = String((f && f.citacao) || '').trim().slice(0, 1500);
    if (t && citacao && citacaoExiste(citacao, t.texto)) {
      aprovados.push({
        trecho_id: t.trecho_id || t.id, documento_id: t.documento_id, tipo: t.tipo, documento: t.titulo_documento || null,
        data_documento: t.data_documento || null, rotulo: t.rotulo || null, pagina: t.pagina || null, citacao,
      });
    } else {
      recusados.push({ trecho_id: f && f.trecho_id, citacao: citacao.slice(0, 200), motivo: t ? 'citacao_nao_encontrada' : 'trecho_fora_da_lista' });
    }
  });
  return { aprovados, recusados };
}

// Lista de trechos para mandar ao modelo, com id curto e o documento de cada um.
function trechosParaPrompt(trechos) {
  return trechos.map((t) => {
    const doc = [t.tipo, t.titulo_documento, t.data_documento].filter(Boolean).join(' | ');
    return '<trecho id="' + (t.trecho_id || t.id) + '" documento="' + doc.replace(/"/g, "'") + '" rotulo="' + String(t.rotulo || '').replace(/"/g, "'") + '"' + (t.pagina ? ' pagina="' + t.pagina + '"' : '') + '>\n' + t.texto + '\n</trecho>';
  }).join('\n\n');
}

module.exports = { normalizar, citacaoExiste, conferirFundamentos, trechosParaPrompt };
