// T17: processamento de documentos, SÓ no servidor. As instruções ficam aqui (fora da
// pasta public) e o navegador só manda o arquivo ou o texto. A resposta volta já
// conferida e no formato que a tela usa; nunca o texto bruto do serviço.

const { chamarModelo, extrairJson } = require('./modelo');

const MODELO_RAPIDO = 'claude-haiku-4-5';
const MODELO_PADRAO = 'claude-sonnet-4-6';

const MIMES_IMAGEM = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const B64_MAX = 10 * 1024 * 1024; // base64 de até ~7,5 MB de arquivo

function blocoArquivo(arq) {
  if (!arq || typeof arq !== 'object') return null;
  const mime = String(arq.mime || '');
  const dados = String(arq.base64 || '');
  if (!dados || dados.length > B64_MAX || !/^[A-Za-z0-9+/=\s]+$/.test(dados.slice(0, 2000))) return null;
  if (mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dados } };
  if (MIMES_IMAGEM.includes(mime)) return { type: 'image', source: { type: 'base64', media_type: mime, data: dados } };
  return null;
}

function erroPadrao(r) {
  if (r && r.status === 504) return { status: 504, corpo: { erro: 'tempo_esgotado', detalhe: 'O processamento demorou demais. Tente de novo.' } };
  return { status: 502, corpo: { erro: 'falha_processamento', detalhe: 'Não foi possível processar o documento agora. Tente de novo em instantes.' } };
}

const NORMALIZAR_SYSTEM_PROMPT = [
  'Voce e um normalizador de dados de unidades condominiais.',
  'O usuario vai te dar um documento (PDF, planilha fora do padrao, Word, imagem ou texto) com informacoes',
  'de unidades + proprietarios + inquilinos + dependentes de um condominio.',
  '',
  'Sua tarefa: transformar cada PESSOA do documento em uma linha JSON (JSON Lines).',
  '',
  'FORMATO DE SAIDA (inviolavel):',
  '- Uma linha por pessoa, cada linha um objeto JSON completo e valido, sem virgula entre linhas.',
  '- Sem markdown, sem cercas ```, sem texto antes ou depois, sem array em volta.',
  '- Inclua SO as chaves que tem valor. Nunca escreva chave com valor vazio.',
  '',
  'CHAVES (use exatamente estes nomes):',
  '  tipo            "Proprietario" | "Inquilino" | "Dependente"',
  '  unidade         numero/nome da unidade (apto, sala, casa, lote), como esta no documento',
  '  bloco           torre, bloco ou quadra',
  '  fracao          fracao ideal (numero decimal)',
  '  metragem        area (numero)',
  '  nome            nome completo da pessoa ou empresa',
  '  cpf             so digitos (11)',
  '  cnpj            so digitos (14)',
  '  rg              como esta no documento',
  '  nascimento      dd/mm/aaaa',
  '  genero          "M" | "F" (so se o documento disser)',
  '  email           endereco de email',
  '  ddi             codigo do pais, padrao "55" quando houver telefone brasileiro',
  '  telefone        so digitos com DDD (ex: 27998148653), sem +, espacos, parenteses ou hifen',
  '  tipo_telefone   "1" fixo | "2" celular | "3" comercial',
  '  cep             so digitos (8)',
  '  endereco, numero, complemento, bairro, cidade',
  '  estado          sigla de 2 letras (ES, SP, RJ...)',
  '  entrada         dd/mm/aaaa (data de entrada do inquilino)',
  '  saida           dd/mm/aaaa',
  '  recebe_cobranca "Sim" | "Nao"',
  '  observacao      texto livre que esteja no documento sobre a pessoa',
  '  duvidas         lista de textos curtos (ver abaixo)',
  '',
  'EXEMPLO:',
  'Entrada (planilha Nome;Apt;Bloco;Tel;Email;Tipo): "Joao da Silva;101;A;(27) 99814-8653;joao@email.com;Proprietario"',
  'Saida:',
  '{"tipo":"Proprietario","unidade":"101","bloco":"A","nome":"Joao da Silva","email":"joao@email.com","ddi":"55","telefone":"27998148653","tipo_telefone":"2"}',
  '',
  'COMO MAPEAR CABECALHOS DIFERENTES:',
  '- "Apt", "Apartamento", "Numero do apartamento", "Unidade" -> unidade',
  '- "Bloco", "Torre", "Quadra", "Bloco / Quadra" -> bloco',
  '- "Tel", "Telefone", "Celular", "Whatsapp" -> telefone',
  '- "Email", "E-mail" -> email',
  '- "Nome", "Morador", "Proprietario", "Condomino" -> nome',
  '- "Locatario" = Inquilino. Varias pessoas na mesma celula (separadas por virgula ou "e") = uma linha para cada pessoa.',
  '- Celula com "-", "nao", "N/A" ou vazia = sem valor.',
  '',
  'TIPO DA PESSOA:',
  '- Use o que o documento diz (proprietario, inquilino/locatario, dependente/morador/familiar).',
  '- Quem aparece numa coluna ou campo de proprietario e Proprietario; de locatario/inquilino e Inquilino.',
  '- Outras pessoas da unidade (condominos, moradores, familiares) que nao sao o proprietario nem o inquilino: Dependente.',
  '- Mesma pessoa citada em dois lugares da mesma unidade (ex: na lista de condominos e como proprietario): UMA linha so, com o tipo mais forte (Proprietario > Inquilino > Dependente).',
  '',
  'REGRA ANTI-INVENCAO: se um dado nao aparece claramente no documento, NAO inclua a chave. Nunca inventar CPF, RG, datas, enderecos, emails ou telefones.',
  '',
  'DUVIDAS (obrigatorio, sem adivinhar):',
  '- Copie nomes exatamente como estao no documento (sem corrigir grafia e sem comentar possivel erro de digitacao).',
  '- Duvida e so para o que impede preencher um campo com seguranca. Nao repita a mesma duvida em todas as pessoas da unidade: coloque so na linha a que ela se refere.',
  '- Valor ilegivel, cortado, ambiguo, ou voce nao tem certeza de qual campo ele e: NAO adivinhe. Deixe sem a chave (ou so a parte legivel) e coloque o motivo em "duvidas".',
  '- Exemplos: "duvidas":["CPF ilegivel"] , "duvidas":["nao sei se e inquilino ou dependente"] , "duvidas":["unidade cortada na imagem"].',
  '- Documento nao diz o tipo da pessoa: nao inclua "tipo" e coloque "tipo nao informado" em duvidas.',
  '- Normalmente cada unidade tem 1 proprietario. Se o documento nao deixar claro quem e, NAO escolha: coloque "proprietario nao identificado" em duvidas.',
  '- Linha do documento que nao e pessoa nem unidade (titulo, total, rodape, assinatura): nao emita.',
  '- Unidade listada sem nenhuma pessoa: emita uma linha so com tipo "Proprietario", unidade, bloco e o que houver (fracao, metragem), sem nome, com "unidade sem pessoa no documento" em duvidas.',
].join('\n');

const EDITAL_SYSTEM_PROMPT = [
  'Voce e um extrator de dados de editais condominiais brasileiros.',
  'O usuario vai te entregar um edital de convocacao (PDF ou imagem).',
  'Sua tarefa: extrair os 5 campos da reuniao em JSON puro, sem markdown, sem cercas, sem comentarios.',
  '',
  'Estrutura EXATA do JSON:',
  '{',
  '  "condominio": string | null,',
  '  "data": string | null,',
  '  "tipo": "AGO" | "AGE" | "Reuniao de Diretoria" | "Reuniao de Moradores" | null,',
  '  "sindico": string | null,',
  '  "local": string | null',
  '}',
  '',
  'Regras invioláveis:',
  '- Use null se o campo nao aparecer claramente no edital. NUNCA invente.',
  '- AGO = Assembleia Geral Ordinaria; AGE = Assembleia Geral Extraordinaria.',
  '- Data sempre no formato DD/MM/AAAA. Use a data da REUNIAO (nao a data da convocacao).',
  '- Se a data estiver por extenso ("01 de abril de 2026"), converta pra 01/04/2026.',
  '- Sindico: extraia somente se mencionado explicitamente como sindico (nao confunda com presidente da mesa).',
  '- Local: extraia o local da reuniao como aparece (ex: "Salao de Festas", "presencial e remoto via Zoom").',
  '- Condominio: extraia o nome oficial como aparece (sem aspas).',
].join('\n');

// ---------- Edital (preenche data, tipo, síndico e local da ata) ----------
const TIPOS_REUNIAO = ['AGO', 'AGE', 'Reuniao de Diretoria', 'Reuniao de Moradores'];
async function processarEdital(corpo, usuario) {
  const bloco = blocoArquivo(corpo && corpo.arquivo);
  if (!bloco) return { status: 400, corpo: { erro: 'arquivo_invalido', detalhe: 'Envie o edital em PDF ou imagem (até 7 MB).' } };
  const r = await chamarModelo({ modelo: MODELO_RAPIDO, maxTokens: 800, system: EDITAL_SYSTEM_PROMPT, cache: true, rotulo: 'edital', usuario,
    content: [bloco, { type: 'text', text: 'Extraia os 5 campos do edital acima em JSON puro, conforme as regras do sistema.' }] });
  if (!r.ok) return erroPadrao(r);
  const j = extrairJson(r.texto);
  if (!j || typeof j !== 'object') return { status: 422, corpo: { erro: 'edital_ilegivel', detalhe: 'Não deu para ler os dados do edital.' } };
  const str = (v) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, 200) || null);
  const data = str(j.data);
  return { status: 200, corpo: { campos: {
    condominio: str(j.condominio),
    data: data && /^\d{2}\/\d{2}\/\d{4}$/.test(data) ? data : null,
    tipo: TIPOS_REUNIAO.includes(j.tipo) ? j.tipo : null,
    sindico: str(j.sindico),
    local: str(j.local),
  } } };
}

// ---------- Foto de medidor (aba Leitura de Consumo) ----------
async function processarMedidor(corpo, usuario) {
  const arq = corpo && corpo.arquivo;
  const bloco = arq && MIMES_IMAGEM.includes(String(arq.mime || '')) ? blocoArquivo(arq) : null;
  if (!bloco) return { status: 400, corpo: { erro: 'arquivo_invalido', detalhe: 'Envie a foto do medidor (JPG, PNG ou WEBP).' } };
  // Segunda leitura (reforco): só para foto que a conferência marcou (ilegível, menor que a
  // anterior ou salto), com a configuração mais cuidadosa.
  const reforco = corpo.reforco === true;
  const cfg = reforco ? MEDIDOR_REFORCO : MEDIDOR_PRIMEIRA;
  // Na releitura, a leitura anterior e a média da unidade (vindas da conferência) ajudam a
  // desempatar algarismo ambíguo. Só números; qualquer outra coisa é ignorada.
  const ctx = reforco ? textoContexto(corpo.contexto) : '';
  const r = await chamarModelo({ modelo: cfg.modelo, esforco: cfg.esforco, maxTokens: cfg.maxTokens, rotulo: reforco ? 'medidor_reforco' : 'medidor', usuario,
    content: [bloco, { type: 'text', text: MEDIDOR_PEDIDO + (ctx ? '\n' + ctx : '') }] });
  if (!r.ok) return erroPadrao(r);
  return { status: 200, corpo: Object.assign(lerRespostaMedidor(r.texto), { reforco, com_referencia: !!ctx }) };
}

function numeroContexto(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(',', '.'));
  return isFinite(n) && n >= 0 && n < 1e9 && String(v).length <= 20 ? Math.round(n * 1000) / 1000 : null;
}
function textoContexto(c) {
  if (!c || typeof c !== 'object') return '';
  const ant = numeroContexto(c.anterior);
  if (ant == null) return '';
  const med = numeroContexto(c.media);
  const f = (n) => String(n).replace('.', ',');
  return 'Conferência: a leitura do mês anterior deste medidor foi ' + f(ant) + (med ? ' e o consumo médio é de ' + f(Math.round(med * 100) / 100) + ' por mês' : '') + '. ' +
    'Use isso SÓ para desempatar algarismo ambíguo na foto (6 ou 8, 1 ou 7, 3 ou 8, rolo girando, foto borrada). Não copie a leitura anterior: o número tem de ser o que a foto mostra. ' +
    'Se a foto mostra com clareza um número diferente do esperado, responda o que a foto mostra. Se não der para ler, legivel false.';
}

// T20: além da leitura, a unidade e o bloco escritos na foto (etiqueta, placa ou caneta) e o
// número de série do medidor, para casar a foto com a unidade do condomínio. O que não aparece
// na foto volta null (nunca adivinhar). Os algarismos vêm separados (inteiros e decimais) e a
// leitura é montada aqui.
// Modelos (comparação de 21/10 com 61 fotos reais de água e gás com o valor do leiturista,
// resultado em EXECUCAO/testes/T20/modelos.md): a primeira leitura usa a configuração de melhor
// custo e acerto; a foto marcada na conferência é lida de novo pela configuração mais cuidadosa.
// Os modelos novos pensam antes de responder: maxTokens alto para não voltar vazio.
// Variáveis: MEDIDOR_MODELO e MEDIDOR_ESFORCO (primeira), MEDIDOR_MODELO_REFORCO e
// MEDIDOR_ESFORCO_REFORCO (segunda); esforço vazio = padrão do modelo.
const _esf = (v, padrao) => (v === undefined ? padrao : (['low', 'medium', 'high'].includes(v) ? v : undefined));
// Padrão (comparação de 21/10 com 61 fotos reais, testes/T20/modelos.md): primeira leitura com
// sonnet 5.5 no esforço baixo (65% exato, cerca de R$ 3,10 por 100 fotos); a foto marcada na
// conferência é relida com sonnet 5.5 no esforço padrão e com a leitura anterior da unidade como
// referência. Conjunto: cerca de 78% exato, R$ 5,10 por 100 fotos, nenhum erro sem suspeita.
const MEDIDOR_PRIMEIRA = { modelo: process.env.MEDIDOR_MODELO || 'claude-sonnet-5-5', esforco: _esf(process.env.MEDIDOR_ESFORCO, 'low'), maxTokens: 6000 };
const MEDIDOR_REFORCO = { modelo: process.env.MEDIDOR_MODELO_REFORCO || 'claude-sonnet-5-5', esforco: _esf(process.env.MEDIDOR_ESFORCO_REFORCO, undefined), maxTokens: 6000 };
const MEDIDOR_PEDIDO = [
  'Foto de medidor de água ou gás de condomínio, tirada pelo leiturista. Leia o mostrador de rolos (números), não os ponteiros dos relógios pequenos.',
  'A foto pode estar girada ou de cabeça para baixo: gire mentalmente até os números ficarem em pé antes de ler. Confira se 6, 8, 9 e 0 não foram trocados.',
  'Regras de leitura:',
  '1. Os rolos de fundo preto ou branco são a parte inteira; os de fundo vermelho (ou depois da vírgula) são a parte decimal. Copie todos, da esquerda para a direita, inclusive zeros à esquerda, sem repetir nem pular rolo. Confira quantos rolos há de cada cor antes de responder.',
  '2. Rolo girando entre dois números: use o MENOR (o que está saindo de cima). De 9 para 0: use 9. Isso é leitura normal, não é ilegível.',
  '3. Parte decimal: copie todos os rolos vermelhos com a mesma regra do rolo girando. Só marque legivel false se um rolo da parte inteira estiver realmente escondido, borrado ou com reflexo a ponto de não dar para saber o número.',
  '4. Unidade: número escrito à mão no medidor ou na parede, etiqueta, placa ou adesivo (exemplos: "01", "APTO 101", "AP 302 BL B", "999 TESTE HUB"). Copie como está. Não confunda com o número de série do medidor.',
  '5. Mais de um mostrador na foto: não escolha; inteiros e decimais null, legivel false e medidores_na_foto com a quantidade.',
  'Responda SÓ com o JSON abaixo, sem explicação nem texto antes ou depois:',
  '{"inteiros": "algarismos da parte inteira ou null", "decimais": "algarismos da parte decimal ou null", "legivel": true ou false, "unidade": "unidade escrita na foto ou null", "bloco": "bloco, torre ou quadra escrito na foto ou null", "medidor": "número de série do medidor ou null", "medidores_na_foto": número de mostradores}',
  'Nunca invente: o que não aparece com clareza fica null.',
].join('\n');

const textoCurto = (v, max) => (v == null ? null : (String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null));
function lerRespostaMedidor(texto) {
  const t = String(texto || '').trim();
  const j = extrairJson(t);
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const nulo = (v) => { const s = textoCurto(v, 40); return s && !/^(null|nenhum|nao|não|n\/a|-)$/i.test(s) ? s : null; };
    const n = parseInt(j.medidores_na_foto, 10);
    const varios = isFinite(n) && n > 1;
    let leitura = 'ilegível';
    const so = (v) => { const s = nulo(v); return s ? s.replace(/\s/g, '') : null; };
    const int = so(j.inteiros), dec = so(j.decimais);
    if (j.legivel !== false && !varios && int && /^[0-9]{1,12}$/.test(int) && (!dec || /^[0-9]{1,4}$/.test(dec))) {
      leitura = int + (dec ? ',' + dec : '');
    } else if (j.inteiros === undefined && j.legivel !== false && !varios) {
      // Formato antigo { leitura: "123,4" }
      const b = so(j.leitura);
      if (b && /^[0-9]{1,12}([.,][0-9]{1,4})?$/.test(b)) leitura = b;
    }
    return { leitura, unidade: nulo(j.unidade), bloco: nulo(j.bloco), medidor: nulo(j.medidor), varios_medidores: varios };
  }
  // Sem JSON: aceita o número mesmo com texto em volta ("Leitura: 1234,5"); sem número claro, ilegível.
  const achado = t.match(/[0-9][0-9.,]{0,14}/g);
  const leitura = achado && achado.length === 1 ? achado[0].replace(/[.,]$/, '') : 'ilegível';
  return { leitura, unidade: null, bloco: null, medidor: null, varios_medidores: false };
}

// ---------- Unidades fora do padrão (aba Unidades, Processar documento) ----------
const CHAVES_UNIDADE = ['tipo','unidade','bloco','fracao','metragem','nome','cpf','cnpj','rg','nascimento','genero','email','ddi','telefone','tipo_telefone','cep','endereco','numero','complemento','bairro','cidade','estado','entrada','saida','recebe_cobranca','observacao'];
const PEDIDO_UNIDADES = 'Transforme cada pessoa do documento acima em uma linha JSON conforme as regras do sistema. Coloque as duvidas em "duvidas".';

function limparLinha(s, max) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, max); }

function montarConteudoUnidades(corpo) {
  if (corpo && corpo.arquivo) {
    const bloco = blocoArquivo(corpo.arquivo);
    return bloco ? [bloco, { type: 'text', text: PEDIDO_UNIDADES }] : null;
  }
  const p = corpo && corpo.parte;
  if (!p || typeof p.texto !== 'string' || !p.texto.trim() || p.texto.length > 20000) return null;
  const total = Math.max(1, Math.min(500, parseInt(p.total, 10) || 1));
  const indice = Math.max(0, Math.min(total - 1, parseInt(p.indice, 10) || 0));
  const rotulo = limparLinha(p.rotulo || 'Documento original', 160);
  const contexto = String(p.contexto || '').slice(0, 1500);
  const texto = (total > 1 && indice > 0 && contexto ? 'COMECO DO DOCUMENTO, so para voce saber o que e cada coluna (NAO emita pessoas destas linhas, elas sao de outra parte):\n' + contexto + '\n\n' : '') +
    rotulo + (total > 1 ? ' (parte ' + (indice + 1) + ' de ' + total + '; a primeira ou a ultima linha pode estar incompleta: se estiver, emita o que da e coloque "dado cortado entre partes" em duvidas)' : '') +
    ':\n\n' + p.texto + '\n\n' + PEDIDO_UNIDADES;
  return [{ type: 'text', text: texto }];
}

// A resposta (uma pessoa por linha em JSON) vira objetos só com as chaves conhecidas.
function lerLinhasUnidades(texto, cortado) {
  const itens = [];
  let invalidas = 0;
  const add = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) { invalidas++; return; }
    const limpo = {};
    CHAVES_UNIDADE.forEach((k) => { if (o[k] != null && String(o[k]).trim()) limpo[k] = limparLinha(o[k], 300).trim(); });
    const duv = (Array.isArray(o.duvidas) ? o.duvidas : o.duvidas ? [o.duvidas] : []).map((d) => limparLinha(d, 200).trim()).filter(Boolean).slice(0, 8);
    if (duv.length) limpo.duvidas = duv;
    if (Object.keys(limpo).length) itens.push(limpo);
  };
  String(texto || '').replace(/```(?:json|jsonl)?\s*|\s*```/g, '').split(/\r?\n/).forEach((l) => {
    l = l.trim().replace(/,$/, '');
    if (!l || l === '[' || l === ']') return;
    let o; try { o = JSON.parse(l); } catch (e) { invalidas++; return; }
    (Array.isArray(o) ? o : [o]).forEach(add);
  });
  return { itens: itens.slice(0, 2000), invalidas: Math.max(0, invalidas - (cortado ? 1 : 0)), cortado: !!cortado };
}

async function processarUnidades(corpo, usuario) {
  const content = montarConteudoUnidades(corpo);
  if (!content) return { status: 400, corpo: { erro: 'parte_invalida', detalhe: 'Parte do documento inválida ou grande demais.' } };
  const r = await chamarModelo({ modelo: MODELO_PADRAO, maxTokens: 24000, system: NORMALIZAR_SYSTEM_PROMPT, cache: true, rotulo: 'unidades', usuario, content });
  if (!r.ok) return erroPadrao(r);
  return { status: 200, corpo: lerLinhasUnidades(r.texto, r.cortado) };
}

module.exports = { processarEdital, processarMedidor, lerRespostaMedidor, textoContexto, processarUnidades, lerLinhasUnidades, montarConteudoUnidades, blocoArquivo };
