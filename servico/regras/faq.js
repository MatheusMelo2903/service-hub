// Regras do condomínio, frente B: perguntas frequentes automáticas por condomínio.
// Para cada tema comum, responde com responder() (mesma conferência de citação da consulta)
// e grava em regras_faq só o que tem fundamento aprovado. Tema sem fundamento não entra:
// FAQ com "não encontrei" não ajuda quem atende o morador.
// As buscas de cada tema já vêm prontas aqui (com o vocabulário de convenção e regimento),
// então o FAQ não gasta a chamada de gerar buscas: uma chamada de processamento por tema.

const { responder, emParalelo } = require('./consulta');

const TEMAS = [
  { tema: 'Obras e reformas', pergunta: 'Qual o horário permitido para obras e reformas nas unidades?', buscas: ['obras e reformas', 'horário de obras', 'reforma unidade'] },
  { tema: 'Mudança', pergunta: 'Quais as regras e horários para mudança?', buscas: ['mudança', 'mudanças horário', 'entrada e saída de mudança'] },
  { tema: 'Piscina', pergunta: 'Quais as regras de uso da piscina?', buscas: ['piscina', 'uso da piscina', 'horário da piscina'] },
  { tema: 'Salão de festas e churrasqueira', pergunta: 'Como funciona a reserva e o uso do salão de festas e da churrasqueira?', buscas: ['salão de festas', 'churrasqueira', 'reserva espaço gourmet'] },
  { tema: 'Animais', pergunta: 'Quais as regras para animais domésticos no condomínio?', buscas: ['animais domésticos', 'animais de estimação', 'cães'] },
  { tema: 'Barulho e horário de silêncio', pergunta: 'Qual o horário de silêncio e as regras sobre barulho?', buscas: ['horário de silêncio', 'silêncio', 'ruídos sons'] },
  { tema: 'Garagem e vagas', pergunta: 'Quais as regras da garagem e das vagas?', buscas: ['garagem', 'vagas de garagem', 'estacionamento veículos'] },
  { tema: 'Aluguel por temporada', pergunta: 'O condomínio permite aluguel por temporada ou por aplicativo?', buscas: ['locação por temporada', 'locação', 'hospedagem curta'] },
  { tema: 'Lixo e coleta', pergunta: 'Como deve ser feito o descarte do lixo?', buscas: ['lixo', 'coleta de lixo', 'resíduos'] },
  { tema: 'Visitantes e prestadores', pergunta: 'Quais as regras para entrada de visitantes e prestadores de serviço?', buscas: ['visitantes', 'prestadores de serviço', 'portaria acesso'] },
  { tema: 'Academia', pergunta: 'Quais as regras de uso da academia?', buscas: ['academia', 'sala de ginástica', 'fitness'] },
  { tema: 'Fumar nas áreas comuns', pergunta: 'É permitido fumar nas áreas comuns?', buscas: ['fumar', 'cigarro', 'fumo áreas comuns'] },
  { tema: 'Penalidades e multas', pergunta: 'Quais as penalidades e multas por descumprimento das regras?', buscas: ['multa', 'penalidades', 'advertência infração'] },
  { tema: 'Assembleia e quórum', pergunta: 'Como é convocada a assembleia e qual o quórum?', buscas: ['assembleia geral', 'quórum', 'convocação'] },
];

// Gera o FAQ de um condomínio e troca o antigo pelo novo. Três temas por vez (a chamada de
// cada um é independente). Se nenhum tema tiver fundamento, NÃO apaga o FAQ antigo (o acervo
// pode estar fora do ar ou sem trechos). Se a gravação falhar, o antigo também fica.
// Devolve { gravados, sem_fundamento: [temas], falhas: [temas] }.
async function gerarFaq(deps, idSL) {
  const id = Number(idSL);
  const resultados = await emParalelo(TEMAS, 3, async (t) => {
    try { return { t, r: await responder(deps, id, t.pergunta, { buscas: t.buscas }) }; } catch (e) {
      console.warn('[regras faq] ' + id + ' tema ' + t.tema + ': ' + (e && e.message));
      return { t, erro: true };
    }
  });
  const linhas = [];
  const semFundamento = [];
  const falhas = [];
  const agora = new Date().toISOString();
  resultados.forEach(({ t, r, erro }) => {
    if (erro) return falhas.push(t.tema);
    if (!r || r.nao_encontrado || !r.fundamentos.length) return semFundamento.push(t.tema);
    // A tabela não tem coluna de conflito (migration é comum): ele vai como um item marcado
    // no fim de fundamentos, e listarFaq separa de volta.
    linhas.push({
      id_superlogica: id, tema: t.tema, pergunta: t.pergunta, resposta: r.resposta, atualizado_em: agora,
      fundamentos: r.conflito ? r.fundamentos.concat([{ conflito: r.conflito }]) : r.fundamentos,
    });
  });
  if (!linhas.length) return { gravados: 0, sem_fundamento: semFundamento, falhas };
  // Grava o novo antes de apagar o antigo: se a gravação falhar, o condomínio não fica sem FAQ.
  const ins = await deps.banco('POST', '/rest/v1/regras_faq', linhas);
  if (ins.status !== 201 || !Array.isArray(ins.body)) throw new Error('gravar_faq_falhou_' + ins.status);
  const novos = ins.body.map((l) => Number(l.id)).filter(Boolean);
  if (novos.length) await deps.banco('DELETE', '/rest/v1/regras_faq?id_superlogica=eq.' + id + '&id=not.in.(' + novos.join(',') + ')');
  return { gravados: linhas.length, sem_fundamento: semFundamento, falhas };
}

// FAQ gravado de um condomínio, na ordem dos temas da lista. O conflito (quando houve) vem
// separado dos fundamentos para a tela mostrar o aviso.
async function listarFaq(deps, idSL) {
  const r = await deps.banco('GET', '/rest/v1/regras_faq?id_superlogica=eq.' + Number(idSL) + '&select=id,tema,pergunta,resposta,fundamentos,atualizado_em&order=id.asc');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('listar_faq_falhou_' + r.status);
  const ordem = new Map(TEMAS.map((t, i) => [t.tema, i]));
  return r.body
    .map((l) => {
      const fs = Array.isArray(l.fundamentos) ? l.fundamentos : [];
      const conflito = fs.find((f) => f && f.conflito);
      return { id: l.id, tema: l.tema, pergunta: l.pergunta, resposta: l.resposta, fundamentos: fs.filter((f) => f && f.citacao), conflito: conflito ? String(conflito.conflito) : '', atualizado_em: l.atualizado_em };
    })
    .sort((a, b) => (ordem.has(a.tema) ? ordem.get(a.tema) : 99) - (ordem.has(b.tema) ? ordem.get(b.tema) : 99));
}

module.exports = { TEMAS, gerarFaq, listarFaq };
