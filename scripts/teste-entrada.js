// Testes da entrada de documentos (T33), sem rede: node scripts/teste-entrada.js
const E = require('../financeiro/entrada');
let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

// Gera linha digitável válida de boleto (banco 001, moeda 9) a partir de fator, valor e campo livre.
function mod10(s) { let soma = 0, p = 2; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i] * p; if (x > 9) x = Math.floor(x / 10) + (x % 10); soma += x; p = p === 2 ? 1 : 2; } const r = soma % 10; return r === 0 ? 0 : 10 - r; }
function linhaBoleto(fator, valorCent, livre) {
  const sem = '0019' + String(fator).padStart(4, '0') + String(valorCent).padStart(10, '0') + livre;
  let soma = 0, p = 2; for (let i = sem.length - 1; i >= 0; i--) { soma += +sem[i] * p; p = p === 9 ? 2 : p + 1; }
  let dv = 11 - (soma % 11); if (dv === 0 || dv === 10 || dv === 11) dv = 1;
  const b = sem.slice(0, 4) + dv + sem.slice(4);
  const c1 = b.slice(0, 4) + b.slice(19, 24), c2 = b.slice(24, 34), c3 = b.slice(34, 44);
  return c1 + mod10(c1) + c2 + mod10(c2) + c3 + mod10(c3) + b[4] + b.slice(5, 19);
}
function linhaArrec(valorCent) {
  const sem = '826' + String(valorCent).padStart(11, '0') + '00010000000000000000000000000'.slice(0, 29);
  const b = sem.slice(0, 3) + mod10(sem) + sem.slice(3); // DV geral na posição 4
  let l = ''; for (let i = 0; i < 4; i++) { const bl = b.slice(i * 11, i * 11 + 11); l += bl + mod10(bl); }
  return l;
}
// CNPJs fictícios com dígito certo
function cnpj(base12) {
  const dv = (b) => { const ps = b.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = b.split('').reduce((a, d, i) => a + +d * ps[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base12); return base12 + d1 + dv(base12 + d1);
}
const COND = cnpj('111111110001'), FORN = cnpj('222222220001');
const fmt = E.formatarCnpj;

// 1. CNPJ
t('cnpj válido', E.cnpjValido(COND) && E.cnpjValido(fmt(FORN)));
t('cnpj inválido', !E.cnpjValido('11111111000100') && !E.cnpjValido('00000000000000'));

// 2. Boleto pelo texto
const fator = 1000 + 600; // 2025-02-22 + 600 dias
const L = linhaBoleto(fator, 123456, '1234567890123456789012345');
t('linha gerada válida', E.linhaBoletoValida(L));
const Lfmt = L.slice(0, 5) + '.' + L.slice(5, 10) + ' ' + L.slice(10, 15) + '.' + L.slice(15, 21) + ' ' + L.slice(21, 26) + '.' + L.slice(26, 32) + ' ' + L[32] + ' ' + L.slice(33);
const txtBoleto = 'Banco do Brasil\nLocal de pagamento: pagável em qualquer banco\nBeneficiário: FORNECEDOR TESTE LTDA CNPJ ' + fmt(FORN) +
  '\nPagador: CONDOMINIO TESTE CNPJ ' + fmt(COND) + '\nNúmero do documento 4567-01\nVencimento 15/10/2026\nValor do documento R$ 1.234,56\n' + Lfmt;
const cb = E.lerCampos(txtBoleto, '2026-10-21');
t('boleto tipo', cb.tipo === 'boleto');
t('boleto valor pela linha', cb.valor === 1234.56 && cb.origem_valor === 'linha');
t('boleto vencimento pelo fator', cb.vencimento === '2026-10-15');
t('boleto documento', cb.documento === '4567-01');
t('boleto papéis', cb.cnpjs.find((c) => c.cnpj === COND).papel === 'pagador' && cb.cnpjs.find((c) => c.cnpj === FORN).papel === 'beneficiario');
t('fator ciclo novo', E.vencimentoDoFator(1000, '2025-03-01') === '2025-02-22');
t('fator longe demais', E.vencimentoDoFator(9999, '2026-10-21') === null || E.vencimentoDoFator(9999, '2026-10-21') > '2024-10-21');
// um dígito trocado no valor: o dígito geral recusa
const Lerr = L.slice(0, 40) + ((+L[40] + 1) % 10) + L.slice(41);
t('linha com dígito trocado recusada', !E.linhaBoletoValida(Lerr) && E.acharLinha(Lerr) === null);

// 3. Arrecadação (concessionária)
const A = linhaArrec(9876);
t('arrecadação válida', E.linhaArrecValida(A));
const ca = E.lerCampos('CONTA DE ÁGUA\nCliente: CONDOMINIO ' + fmt(COND) + '\n' + A.match(/.{12}/g).join(' '), '2026-10-21');
t('arrecadação fatura e valor', ca.tipo === 'fatura' && ca.valor === 98.76);

// 4. Nota de serviço nacional com chave
const chave = '3205002' + '2' + '2' + FORN + String(202).padStart(13, '0') + '2608' + '378198279' + '9';
const txtNota = 'DANFSe v2.0 Documento Auxiliar da NFS-e\nCHAVE DE ACESSO DA NFS-e\n' + chave + '\nCOMPETÊNCIA\nDATA E HORA DA EMISSÃO DA NFS-e\n05/08/2026 15:49\nTOMADOR / ADQUIRENTE CNPJ\n' + fmt(COND) + '\nValor Líquido da NFS-e R$ 2.894,40';
const cn = E.lerCampos(txtNota, '2026-10-21');
t('nota tipo', cn.tipo === 'nota');
t('nota número pela chave', cn.documento === '202');
t('nota emitente beneficiário', (cn.cnpjs.find((c) => c.cnpj === FORN) || {}).papel === 'beneficiario');
t('nota tomador pagador', (cn.cnpjs.find((c) => c.cnpj === COND) || {}).papel === 'pagador');
t('nota valor líquido', cn.valor === 2894.4);
t('nota emissão', cn.emissao === '2026-08-05');

// 5. Comprovante e guia
t('comprovante', E.lerCampos('COMPROVANTE DE PAGAMENTO DE BOLETO\nAutenticação: abc\nPagador CNPJ ' + fmt(COND)).tipo === 'comprovante');
t('guia DARF', E.lerCampos('Documento de Arrecadação de Receitas Federais DARF\nContribuinte ' + fmt(COND) + '\nValor total R$ 10,00').tipo === 'guia');
t('nota com simples nacional não vira guia', E.lerCampos('NFS-e Nota Fiscal de Serviço\nSimples Nacional optante\nValor do serviço R$ 50,00').tipo === 'nota');

// 6. Leitura interna: linha que não confere é descartada; CNPJ inválido também
const ci = E.camposDaLeitura({ tipo: 'boleto', valor: '1.234,56', vencimento: '15/10/2026', linha_digitavel: Lerr, cnpj_pagador: '11111111000100', cnpj_beneficiario: FORN }, '2026-10-21');
t('interna sem linha inválida', ci.linha === null && ci.valor === 1234.56 && ci.origem_valor === 'leitura');
t('interna só CNPJ válido', ci.cnpjs.length === 1 && ci.cnpjs[0].cnpj === FORN);
const ci2 = E.camposDaLeitura({ tipo: 'boleto', valor: '9,99', linha_digitavel: L }, '2026-10-21');
t('interna com linha válida usa o valor da linha', ci2.valor === 1234.56 && ci2.origem_valor === 'linha');
const junto = E.juntarLeituras({ tipo: 'outro', valor: null, vencimento: null, linha: L, barras: 'x', cnpjs: [] }, { tipo: 'nota', valor: 5, vencimento: '2026-10-01', cnpjs: [{ cnpj: COND, papel: 'pagador', ordem: 0 }] }, false);
t('juntar completa o que faltou', junto.valor === 5 && junto.tipo === 'nota' && junto.linha === L && junto.cnpjs.length === 1);

// 7. Duplicidade
const d = { id_fornecedor: '10', valor: 100, vencimento: '2026-10-15', documento: '0045', linha: L, barras: E.barrasDaLinha(L) };
const p = (o) => Object.assign({ id_despesa_des: '1', id_parcela_pdes: '2', id_contato_con: '10', st_documento_des: '', vl_valor_pdes: '50.00', dt_vencimento_pdes: '01/01/2026 00:00:00', st_codigobarras_pdes: '' }, o);
t('dup mesma linha', E.acharDuplicidades([p({ st_codigobarras_pdes: L, id_contato_con: '99' })], d)[0].motivos.includes('mesma_linha'));
t('dup mesmo código de barras', E.acharDuplicidades([p({ st_codigobarras_pdes: E.barrasDaLinha(L) })], d).length === 1);
t('dup mesmo documento e fornecedor', E.acharDuplicidades([p({ st_documento_des: '45' })], d)[0].motivos.includes('mesmo_documento'));
t('doc igual de outro fornecedor não é dup', E.acharDuplicidades([p({ st_documento_des: '45', id_contato_con: '11' })], d).length === 0);
t('dup valor 10 dias', E.acharDuplicidades([p({ vl_valor_pdes: '100.00', dt_vencimento_pdes: '10/25/2026 00:00:00' })], d).length === 1);
t('11 dias não é dup', E.acharDuplicidades([p({ vl_valor_pdes: '100.00', dt_vencimento_pdes: '10/26/2026 00:00:00' })], d).length === 0);
t('conta sugerida', (E.contaSugerida([p({ apropriacao: [{ st_conta_cont: '2.1.1', st_descricao_cont: 'X' }] })], '10') || {}).conta === '2.1.1');

// 8. Pode lançar
t('impede', !E.podeLancar([{ codigo: 'sem_conta', nivel: 'impede' }], []).ok);
t('grave sem aceite', E.podeLancar([{ codigo: 'duplicidade', nivel: 'grave' }], []).motivo === 'grave_nao_aceito');
t('grave aceito', E.podeLancar([{ codigo: 'duplicidade', nivel: 'grave' }, { codigo: 'vencido', nivel: 'aviso' }], ['duplicidade']).ok);

// 9. Trava do lançamento
// T40: ENTRADA_LANCAMENTO_LIBERADO (padrão só 167); a antiga ENTRADA_LIBERADA não libera nada.
t('sem variável só 167', E.lancamentoLiberado('167', {}) && !E.lancamentoLiberado('136', {}));
t('variável vazia vale só 167', !E.lancamentoLiberado('136', { ENTRADA_LANCAMENTO_LIBERADO: '  ' }) && E.lancamentoLiberado('167', { ENTRADA_LANCAMENTO_LIBERADO: '  ' }));
t('todos não libera', !E.lancamentoLiberado('136', { ENTRADA_LANCAMENTO_LIBERADO: 'todos' }));
t('variável antiga não libera', !E.lancamentoLiberado('136', { ENTRADA_LIBERADA: 'todos' }));
t('lista', E.lancamentoLiberado('136', { ENTRADA_LANCAMENTO_LIBERADO: '136,140' }) && !E.lancamentoLiberado('2', { ENTRADA_LANCAMENTO_LIBERADO: '136,140' }));

// 10. Corpo da despesa e nome de arquivo
const corpo = new URLSearchParams(E.corpoDespesa({ id_superlogica: '167', id_fornecedor: '6263', nome_fornecedor: 'F', vencimento: '2026-11-05', forma_pag: 0, tipo: 'nota', documento: 'T33', conta: '2.2.60', valor: 1, id_arquivo: '9', linha: L }));
t('corpo campos', corpo.get('ID_CONDOMINIO_COND') === '167' && corpo.get('DT_VENCIMENTOPRIMEIRAPARCELA') === '11/05/2026' && corpo.get('APROPRIACAO[0][VL_VALOR_PDES]') === '1.00' && corpo.get('ARQUIVOS[0][ID_ARQUIVO_ARQ]') === '9' && corpo.get('ID_TIPO_DOC') === '1');
t('nome de arquivo seguro', !/["\r\n]/.test(E.nomeArquivoSeguro('a"b\r\nContent-Type: x.pdf')) && /\.pdf$/.test(E.nomeArquivoSeguro('x')));
t('pdf', E.ehPdf(Buffer.from('%PDF-1.4\n' + 'x'.repeat(200))) && !E.ehPdf(Buffer.from('<html>' + 'x'.repeat(200))));
t('dinheiro', E.lerDinheiro('R$ 1.234,56') === 1234.56 && E.lerDinheiro('12,3') === null);

// 11. Extração em thread separada: PDF quebrado volta null sem derrubar o processo.
(async () => {
  const r = await E.extrairTexto(Buffer.from('%PDF-1.4\n' + 'lixo '.repeat(500)));
  t('pdf quebrado volta null', r === null);
  console.log('entrada: ' + ok + ' ok, ' + falhou + ' falhou');
  process.exit(falhou ? 1 : 0);
})();
