// T17: monta no servidor o pedido de geração da ata (antes era montado no navegador,
// o que deixava as instruções visíveis para qualquer usuário). Mesmo texto de antes.

const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const TIPOS = ['AGO', 'AGE', 'Reunião de Diretoria', 'Reunião de Moradores', 'Reuniao de Diretoria', 'Reuniao de Moradores'];

const lin = (v, max) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 300);

function dataPorExtenso(data) {
  const m = String(data || '').match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return data;
  const d = parseInt(m[1], 10); const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) return data;
  return String(d).padStart(2, '0') + ' de ' + MESES[mes - 1] + ' de ' + m[3];
}

// dados: { condominio, cnpj, endereco, cadastro_oficial, tipo, data, sindico, local, participantes, pautas[], editais[{titulo, arquivo, texto}] }
function montarMensagemAta(dados, transcricao) {
  const d = dados || {};
  const data = lin(d.data, 20);
  const extenso = dataPorExtenso(data);
  const pautas = (Array.isArray(d.pautas) ? d.pautas : []).slice(0, 40).map((t, i) => (i + 1) + '. ' + lin(t, 300)).filter((t) => t.length > 3);
  const editais = (Array.isArray(d.editais) ? d.editais : []).slice(0, 10).filter((e) => e && typeof e.texto === 'string' && e.texto.trim())
    .map((e, i) => ({ n: i + 1, titulo: lin(e.titulo || '(sem título)', 200), arquivo: lin(e.arquivo, 200), texto: String(e.texto).slice(0, 200000) }));
  let blocoEditais = '';
  if (editais.length) {
    blocoEditais = '\n=== EDITAIS / DOCUMENTOS ANEXADOS ===\n' +
      '(Use o edital como fonte oficial dos pontos que DEVERIAM ser deliberados — a transcrição mostra o que DE FATO foi discutido. Cruze: edital + transcrição confirmando → registre com precisão; números/datas/valores do edital prevalecem como oficiais; transcrição contradiz edital → registre o efetivamente deliberado.)\n\n' +
      editais.map((e) => '--- ' + e.n + '. ' + e.titulo + (e.arquivo ? ' [arquivo: ' + e.arquivo + ']' : '') + ' ---\n' + e.texto).join('\n\n') + '\n';
  }
  const tipo = TIPOS.includes(d.tipo) ? d.tipo : lin(d.tipo, 60);
  const partic = String(d.participantes || '').slice(0, 20000).trim();
  return [
    '=== DADOS DA REUNIÃO ===',
    'Condomínio: ' + lin(d.condominio, 200),
    'CNPJ: ' + (lin(d.cnpj, 30) || '[a confirmar]'),
    'Endereço: ' + (lin(d.endereco, 300) || '[a confirmar]'),
    (d.cadastro_oficial ? '(Nome, CNPJ, endereço e síndico vêm do cadastro oficial do condomínio no Superlógica: use exatamente estes no cabeçalho.)' : ''),
    'Tipo: ' + tipo,
    'Data: ' + data + (extenso !== data ? ' (' + extenso + ')' : ''),
    'Síndico: ' + (lin(d.sindico, 200) || '[a confirmar]'),
    'Local: ' + (lin(d.local, 300) || '[a confirmar]'),
    '',
    '=== ITENS DE PAUTA ===',
    pautas.length ? pautas.join('\n') : '(extrair da transcrição e/ou dos editais anexados abaixo)',
    blocoEditais,
    '=== PARTICIPANTES ===',
    partic || '(extrair da transcrição; se não identificáveis, use [a confirmar])',
    '',
    '=== TRANSCRIÇÃO COMPLETA DA REUNIÃO ===',
    String(transcricao || ''),
    '',
    'Gere a ata completa seguindo todas as regras e estrutura do sistema. Use [a confirmar] em qualquer dado ausente.'
  ].join('\n');
}

// O que volta ao navegador no fim da geração: só o que a tela usa. Nada de nome de
// modelo, tentativas, telemetria ou erro técnico do serviço.
function limparResultadoAta(p) {
  const r = p || {};
  const docs = Array.isArray(r.documentos) ? r.documentos.map((x) => ({ nome: x && x.nome, falhou: !!(x && x.falhou), truncado: !!(x && x.truncado), imagens_falharam: (x && x.imagens_falharam) || 0 })) : undefined;
  const conf = r.conferencia ? { divergencias: r.conferencia.divergencias || 0, valores_so_documento: r.conferencia.valores_so_documento || 0 } : undefined;
  const gate = r.gate && Array.isArray(r.gate.flags) ? { flags: r.gate.flags } : undefined;
  // T47: tempos por etapa (só segundos, sem detalhe técnico) para medir a velocidade da geração.
  const tempos = r.tempos && typeof r.tempos === 'object' ? r.tempos : undefined;
  return { ata: r.ata, avisos: Array.isArray(r.avisos) ? r.avisos : [], gate, documentos: docs, participantes: r.participantes, conferencia: conf, tempos };
}
function limparErroAta(e) {
  const erro = e && e.erro;
  if (erro === 'documentos_invalidos' || erro === 'id_invalido') return { erro, detalhe: e.detalhe };
  return { erro: 'falha_geracao', detalhe: 'Não foi possível gerar a ata agora. Tente de novo em instantes.' };
}

module.exports = { montarMensagemAta, limparResultadoAta, limparErroAta, dataPorExtenso };
