// T42: nome dos modelos de processamento num lugar só. Trocar depois sem caçar no código:
// cada função lê primeiro MODELO_<FUNCAO> (ex.: MODELO_EDITAL), depois o nome antigo da
// variável (quando existia) e por fim o padrão abaixo. Lido na hora da chamada, então uma
// variável nova vale no próximo processamento, sem mudar código.
// Escolha de cada padrão e os testes com dados reais: EXECUCAO/testes/T42/resultado.md.

const PADRAO = {
  ata: 'claude-sonnet-5-5',                // geração, auditoria, inserção, nomes e documentos da ata (T19)
  ata_ultimo_recurso: 'claude-opus-4-7',   // inserção das lacunas quando a primeira tentativa quebra
  comunicado: 'claude-sonnet-5-5',         // rascunho de comunicado e multa
  edital: 'claude-haiku-4-5',              // dados do edital da assembleia
  unidades: 'claude-sonnet-4-6',           // normalizar unidades e moradores
  prestacao: 'claude-sonnet-4-6',          // composição das despesas da prestação de contas
  medidor: 'claude-sonnet-5-5',            // primeira leitura da foto do medidor (T20)
  medidor_reforco: 'claude-sonnet-5-5',    // releitura da foto marcada (T20)
  entrada_documento: 'claude-sonnet-5-5',  // documento escaneado da entrada de documentos (T33)
};

// Nomes de variável que já existiam antes da T42 (continuam valendo).
const LEGADO = {
  ata: 'ATA_MODELO',
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
// vazio ou outro valor = padrão do modelo. Só as funções listadas aqui leem a variável.
const ESFORCO_PADRAO = { unidades: undefined, prestacao: undefined };
function esforco(funcao) {
  if (!Object.prototype.hasOwnProperty.call(ESFORCO_PADRAO, funcao)) return undefined;
  const v = String(process.env['ESFORCO_' + funcao.toUpperCase()] || '').trim();
  return ['low', 'medium', 'high'].includes(v) ? v : ESFORCO_PADRAO[funcao];
}

module.exports = { modelo, esforco, PADRAO, LEGADO, ESFORCO_PADRAO };
