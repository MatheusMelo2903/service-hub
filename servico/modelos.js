// T42: nome dos modelos de processamento num lugar só. Trocar depois sem caçar no código:
// cada função lê primeiro MODELO_<FUNCAO> (ex.: MODELO_EDITAL), depois o nome antigo da
// variável (quando existia) e por fim o padrão abaixo. Lido na hora da chamada, então uma
// variável nova vale no próximo processamento, sem mudar código.
// Escolha de cada padrão e os testes com dados reais: EXECUCAO/testes/T42/resultado.md.

const PADRAO = {
  ata: 'claude-sonnet-5-5',                // geração, auditoria, inserção, nomes e documentos da ata (T19)
  ata_ultimo_recurso: 'claude-opus-4-7',   // inserção das lacunas quando a primeira tentativa quebra
  comunicado: 'claude-sonnet-5-5',         // rascunho de comunicado e multa
  edital: 'claude-haiku-5-5',              // dados do edital (T42: 60/60 igual ao haiku 4.5, 7x mais barato)
  unidades: 'claude-sonnet-5-5',           // normalizar unidades (T42: esforço baixo, campos iguais ou melhores, 18% mais barato)
  prestacao: 'claude-sonnet-5-5',          // composição da prestação (T42: esforço baixo, menos descarte, 27 a 57% mais barato)
  medidor: 'claude-sonnet-5-5',            // primeira leitura da foto do medidor (T20)
  medidor_reforco: 'claude-sonnet-5-5',    // releitura da foto marcada (T20)
  entrada_documento: 'claude-sonnet-5-5',  // documento escaneado da entrada de documentos (T33)
  regras: 'claude-sonnet-5-5',             // consulta, notificação e conferência com base no regimento e na convenção
  regras_leitura: 'claude-sonnet-5-5',     // leitura de PDF escaneado de convenção, regimento ou ata enviado ao acervo
  regras_extracao: 'claude-haiku-5-5',     // mandatos e resumo de ata (campos simples)
  apresentacao: 'claude-sonnet-5-5',       // roteiro da apresentação de assembleia (só texto)
  apresentacao_imagens: 'claude-haiku-5-5', // conferência barata das imagens dos documentos da apresentação
};

// Nomes de variável que já existiam antes da T42 (continuam valendo).
const LEGADO = {
  ata: 'ATA_MODELO',
  comunicado: 'ATA_MODELO', // antes da T42 o comunicado seguia o modelo da ata
  prestacao: 'PRESTACAO_MODELO',
  medidor: 'MEDIDOR_MODELO',
  medidor_reforco: 'MEDIDOR_MODELO_REFORCO',
  entrada_documento: 'ENTRADA_MODELO',
};

const NOME_VALIDO = /^[a-z0-9][a-z0-9.\-]{2,60}$/;

function modelo(funcao) {
  if (!Object.prototype.hasOwnProperty.call(PADRAO, funcao)) throw new Error('funcao_sem_modelo: ' + funcao);
  const candidatos = [process.env['MODELO_' + funcao.toUpperCase()], LEGADO[funcao] && process.env[LEGADO[funcao]]];
  for (const c of candidatos) {
    const v = String(c || '').trim();
    if (v && NOME_VALIDO.test(v)) return v;
  }
  return PADRAO[funcao];
}

// Esforço (nos modelos que pensam antes de responder): ESFORCO_<FUNCAO> = low, medium ou high;
// 'nenhum' não manda o campo (modelo que não aceita esforço); vazio ou outro valor = padrão abaixo.
// Só as funções listadas aqui leem a variável.
const ESFORCO_PADRAO = { unidades: 'low', prestacao: 'low', apresentacao: 'low' };
function esforco(funcao) {
  if (!Object.prototype.hasOwnProperty.call(ESFORCO_PADRAO, funcao)) return undefined;
  const v = String(process.env['ESFORCO_' + funcao.toUpperCase()] || '').trim();
  if (v === 'nenhum') return undefined;
  return ['low', 'medium', 'high'].includes(v) ? v : ESFORCO_PADRAO[funcao];
}

module.exports = { modelo, esforco, PADRAO, LEGADO, ESFORCO_PADRAO };
