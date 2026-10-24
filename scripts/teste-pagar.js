// Testes de Contas a pagar, sem rede e com o Superlógica dublado:
// NODE_PATH=<repo>/node_modules node scripts/teste-pagar.js
// Parte 1: regras puras (chave Pix, Pix copia e cola, parcelas, rateio, pacote, corpo da despesa,
// decisão da baixa, comprovante, dias úteis, contas esperadas, prazos, casamento do retorno e do extrato).
// Parte 2: gravação com o Superlógica dublado (lançamento completo, remessa, baixa, fornecedor).
// Parte 3: as rotas num express local com banco em memória e a política única de verdade
// (167 grava sozinho, outro condomínio bloqueado, quem lançou não dá a baixa, aprovação de fornecedor).
process.env.NODE_ENV = 'test';
const assert = require('assert');
const E = require('../financeiro/entrada');
const P = require('../financeiro/pagar');
const Z = require('../financeiro/pagar-prazos');
const B = require('../financeiro/pagar-baixa');
const W = require('../servico/escrita-superlogica');

let ok = 0, falhou = 0;
function t(nome, cond) { if (cond) ok++; else { falhou++; console.log('FALHOU: ' + nome); } }

function mod10(s) { let soma = 0, p = 2; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i] * p; if (x > 9) x = Math.floor(x / 10) + (x % 10); soma += x; p = p === 2 ? 1 : 2; } const r = soma % 10; return r === 0 ? 0 : 10 - r; }
function linhaBoleto(vencIso, valorCent, livre) {
  const fator = 1000 + Math.round((Date.parse(vencIso + 'T12:00:00Z') - Date.parse('2025-02-22T12:00:00Z')) / 86400000);
  const sem = '0019' + String(fator).padStart(4, '0') + String(valorCent).padStart(10, '0') + livre;
  let soma = 0, p = 2; for (let i = sem.length - 1; i >= 0; i--) { soma += +sem[i] * p; p = p === 9 ? 2 : p + 1; }
  let dv = 11 - (soma % 11); if (dv === 0 || dv === 10 || dv === 11) dv = 1;
  const b = sem.slice(0, 4) + dv + sem.slice(4);
  const c1 = b.slice(0, 4) + b.slice(19, 24), c2 = b.slice(24, 34), c3 = b.slice(34, 44);
  return c1 + mod10(c1) + c2 + mod10(c2) + c3 + mod10(c3) + b[4] + b.slice(5, 19);
}
function brcode(chave, valor, dinamico) {
  const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const mai = tlv('00', 'br.gov.bcb.pix') + (dinamico ? tlv('25', 'qr.exemplo.com.br/cob/123') : tlv('01', chave));
  const s = tlv('00', '01') + tlv('26', mai) + tlv('52', '0000') + tlv('53', '986') + (valor ? tlv('54', valor) : '') + tlv('58', 'BR') + tlv('59', 'TESTE') + tlv('60', 'VITORIA') + tlv('62', tlv('05', '***')) + '6304';
  return s + P.crc16(s);
}
const HOJE = '2026-10-23';
const sl = (iso) => E.isoParaSL(iso) + ' 00:00:00';

(async () => {
  // ---------- 1. chave Pix ----------
  t('pix cnpj', P.lerChavePix('00.000.000/0001-91').tipo === 'cnpj' && P.lerChavePix('00.000.000/0001-91').codigo === 2 && P.lerChavePix('00.000.000/0001-91').chave === '00000000000191');
  t('pix cnpj errado', !!P.lerChavePix('00.000.000/0001-92').erro);
  t('pix email', P.lerChavePix('Fornecedor@Exemplo.com').chave === 'fornecedor@exemplo.com' && P.lerChavePix('a@b.com').codigo === 4);
  t('pix telefone com +55', P.lerChavePix('+55 (27) 99999-0000').chave === '+5527999990000' && P.lerChavePix('+5527999990000').codigo === 3);
  t('pix aleatoria', P.lerChavePix('123e4567-e89b-12d3-a456-426614174000').tipo === 'aleatoria');
  t('pix ambiguo pede tipo', /tipo/.test(P.lerChavePix('27999990000').erro || '') && P.lerChavePix('27999990000', 'telefone').chave === '+5527999990000');
  t('pix cpf com tipo', P.lerChavePix('529.982.247-25', 'cpf').chave === '52998224725' && !!P.lerChavePix('529.982.247-24', 'cpf').erro);
  t('pix tipo errado', !!P.lerChavePix('a@b.com', 'cnpj').erro);
  // ---------- 2. copia e cola ----------
  const cc = brcode('fornecedor@exemplo.com', '150.00');
  const lc = P.lerPixCopiaCola(cc);
  t('copia e cola lido', lc.chave === 'fornecedor@exemplo.com' && lc.valor_centavos === 15000);
  t('copia e cola crc errado', !!P.lerPixCopiaCola(cc.slice(0, -1) + (cc.slice(-1) === '0' ? '1' : '0')).erro);
  t('copia e cola dinâmico recusado', P.lerPixCopiaCola(brcode(null, '10.00', true)).dinamico === true);
  t('copia e cola lixo', !!P.lerPixCopiaCola('abc').erro);
  // ---------- 3. código de barras, parcelas e rateio ----------
  const L1 = linhaBoleto('2026-11-10', 60000, '1111111111111111111111111');
  const L2 = linhaBoleto('2026-12-10', 40000, '2222222222222222222222222');
  t('código lido pela linha e pelas barras', !!P.lerCodigo(L1, HOJE) && P.lerCodigo(E.barrasDaLinha(L1), HOJE).linha === L1 && P.lerCodigo(L1.slice(0, -1) + '9', HOJE) === null);
  let cp = P.conferirParcelas(100000, [{ vencimento: '2026-11-10', valor: 600, linha: L1 }, { vencimento: '2026-12-10', valor: 400, linha: L2 }], HOJE);
  t('parcelas ok', cp.ok && cp.ok.length === 2 && cp.ok[1].valor_centavos === 40000 && cp.ok[0].linha === L1);
  t('parcelas soma errada', /soma/.test(P.conferirParcelas(100000, [{ vencimento: '2026-11-10', valor: 600 }], HOJE).erro));
  t('parcelas fora de ordem', /ordem/.test(P.conferirParcelas(100000, [{ vencimento: '2026-12-10', valor: 400 }, { vencimento: '2026-11-10', valor: 600 }], HOJE).erro));
  t('parcela com código de outro valor', /traz/.test(P.conferirParcelas(100000, [{ vencimento: '2026-11-10', valor: 400, linha: L1 }, { vencimento: '2026-12-10', valor: 600 }], HOJE).erro));
  t('mesmo código em duas parcelas', /duas parcelas/.test(P.conferirParcelas(120000, [{ vencimento: '2026-11-10', valor: 600, linha: L1 }, { vencimento: '2026-11-10', valor: 600, linha: L1 }], HOJE).erro));
  t('código com dígito errado', /não confere/.test(P.conferirParcelas(60000, [{ vencimento: '2026-11-10', valor: 600, linha: L1.slice(0, 9) + ((+L1[9] + 1) % 10) + L1.slice(10) }], HOJE).erro));
  t('dividir', JSON.stringify(P.dividir(1000, 3, '2026-01-31').map((p) => [p.vencimento, p.valor_centavos])) === JSON.stringify([['2026-01-31', 334], ['2026-02-28', 333], ['2026-03-31', 333]]));
  const PLANO = [{ conta: '2.2.1', nome: 'Tarifas' }, { conta: '2.3.1', nome: 'Manutenção' }];
  t('rateio ok', P.conferirRateio(100000, [{ conta: '2.2.1', valor: 700 }, { conta: '2.3.1', valor: 300 }], PLANO).ok.length === 2);
  t('rateio conta fora do plano', /não existe/.test(P.conferirRateio(100000, [{ conta: '9.9', valor: 1000 }], PLANO).erro));
  t('prova do rateio pela fração', P.provaRateio({ apropriacao: [{ st_conta_cont: '2.2.1', vl_valor_apro: '0.60000000000' }, { st_conta_cont: '2.2.2', vl_valor_apro: '0.40000000000' }] }, [{ conta: '2.2.1', valor_centavos: 30 }, { conta: '2.2.2', valor_centavos: 20 }])
    && !P.provaRateio({ apropriacao: [{ st_conta_cont: '2.2.1', vl_valor_apro: '0.30' }, { st_conta_cont: '2.2.2', vl_valor_apro: '0.20' }] }, [{ conta: '2.2.1', valor_centavos: 30 }, { conta: '2.2.2', valor_centavos: 20 }]));
  t('rateio soma', /soma/.test(P.conferirRateio(100000, [{ conta: '2.2.1', valor: 900 }], PLANO).erro));
  // ---------- 4. pacote ----------
  let pk = P.conferirPacote({ valor: 1000, vencimento: '2026-11-10', forma_pag: 0, linha: null, conta: '2.2.1' }, { parcelas: [{ vencimento: '2026-11-10', valor: 600, linha: L1 }, { vencimento: '2026-12-10', valor: 400, linha: L2 }], rateio: [{ conta: '2.2.1', valor: 700 }, { conta: '2.3.1', valor: 300 }], remessa: true }, PLANO, HOJE);
  t('pacote boleto parcelado com remessa', pk.ok && pk.ok.parcelas.length === 2 && pk.ok.rateio.length === 2 && pk.ok.remessa === true && pk.ok.forma === 0);
  t('pacote padrão usa o documento', P.conferirPacote({ valor: 600, vencimento: '2026-11-10', forma_pag: 0, linha: L1, conta: '2.2.1' }, {}, PLANO, HOJE).ok.parcelas[0].linha === L1);
  t('remessa sem código recusa', /código de barras/.test(P.conferirPacote({ valor: 600, vencimento: '2026-11-10', forma_pag: 0, conta: '2.2.1' }, { remessa: true }, PLANO, HOJE).erro));
  t('pix sem chave recusa', /chave Pix/.test(P.conferirPacote({ valor: 150, vencimento: '2026-11-10', forma_pag: 12, conta: '2.2.1' }, {}, PLANO, HOJE).erro));
  pk = P.conferirPacote({ valor: 150, vencimento: '2026-11-10', forma_pag: 14, conta: '2.2.1' }, { copia_cola: cc }, PLANO, HOJE);
  t('copia e cola vira Pix com a chave do código', pk.ok && pk.ok.forma === 12 && pk.ok.pix.chave === 'fornecedor@exemplo.com' && pk.ok.pix.codigo === 4);
  t('copia e cola de outro valor recusa', /traz/.test(P.conferirPacote({ valor: 100, vencimento: '2026-11-10', forma_pag: 14, conta: '2.2.1' }, { copia_cola: cc }, PLANO, HOJE).erro));
  t('chave pix com forma boleto recusa', /forma de pagamento Pix/.test(P.conferirPacote({ valor: 150, vencimento: '2026-11-10', forma_pag: 0, conta: '2.2.1' }, { pix: { chave: 'a@b.com' } }, PLANO, HOJE).erro));
  t('remessa de parcela vencida recusa', /vencida/.test(P.conferirPacote({ valor: 600, vencimento: '2026-10-01', forma_pag: 0, linha: null, conta: '2.2.1' }, { parcelas: [{ vencimento: '2026-10-01', valor: 600, linha: linhaBoleto('2026-10-01', 60000, '3'.repeat(25)) }], remessa: true }, PLANO, HOJE).erro));
  // ---------- 5. corpo da despesa ----------
  const pkPix = P.conferirPacote({ valor: 1000, vencimento: '2026-11-10', forma_pag: 12, conta: '2.2.1' }, { pix: { chave: '00.000.000/0001-91' }, parcelas: [{ vencimento: '2026-11-10', valor: 500 }, { vencimento: '2026-12-10', valor: 500 }] }, PLANO, HOJE).ok;
  const corpo = P.corpoDespesaCompleta(Object.assign({ id_superlogica: '167', id_fornecedor: '68185', nome_fornecedor: 'F', tipo: 'nota', documento: 'NF1', id_contabanco: '823', id_arquivo: '9' }, pkPix));
  t('corpo: parcelas sempre em DESPESA_PARCELA', corpo.NM_PARCELAS === 2 && corpo['DESPESA_PARCELA[1][DT_VENCIMENTO_PDES]'] === '12/10/2026' && corpo['DESPESA_PARCELA[1][VL_VALOR_PDES]'] === '500.00');
  t('corpo: chave Pix na parcela, nunca no topo', corpo['DESPESA_PARCELA[0][ST_PIXCHAVE_PDES]'] === '00000000000191' && corpo['DESPESA_PARCELA[0][FL_PIXTIPOCHAVE_PDES]'] === 2 && corpo.ST_PIXCHAVE_PDES === undefined && corpo.ST_PIXQRCODE_PDES === undefined);
  t('corpo: rateio em APROPRIACAO e forma', corpo['APROPRIACAO[0][ST_CONTA_CONT]'] === '2.2.1' && corpo['APROPRIACAO[0][VL_VALOR_PDES]'] === '1000.00' && corpo.ID_FORMA_PAG === 12 && corpo['ARQUIVOS[0][ID_ARQUIVO_ARQ]'] === '9');
  t('corpo: data no formato do Superlógica', corpo.DT_VENCIMENTOPRIMEIRAPARCELA === '11/10/2026');
  // ---------- 6. decisão da baixa ----------
  const desp = (o) => Object.assign({ id_parcela: 1, valor_centavos: 10000, liquidada: false, vencimento: '2026-10-20' }, o);
  t('baixa: confere no valor', P.decidirBaixa({ situacao: 'divergente', despesa: desp(), achados: [{ tipo: 'sem_baixa' }], valor_pago_centavos: 10000 }).acao === 'baixar');
  let dc = P.decidirBaixa({ situacao: 'divergente', despesa: desp(), achados: [{ tipo: 'pago_a_maior' }, { tipo: 'sem_baixa' }], valor_pago_centavos: 10250 });
  t('baixa: acréscimo vira juros', dc.acao === 'baixar' && dc.juros_centavos === 250 && dc.multa_centavos === 0);
  t('baixa: acréscimo alto vai conferir', P.decidirBaixa({ situacao: 'divergente', despesa: desp(), achados: [{ tipo: 'pago_a_maior' }], valor_pago_centavos: 12000 }).acao === 'conferir');
  t('baixa: pago a menor vai conferir', P.decidirBaixa({ situacao: 'divergente', despesa: desp(), achados: [{ tipo: 'pago_a_menor', detalhe: 'x' }], valor_pago_centavos: 9000 }).acao === 'conferir');
  t('baixa: beneficiário diferente vai conferir', P.decidirBaixa({ situacao: 'divergente', despesa: desp(), achados: [{ tipo: 'beneficiario_diferente', detalhe: 'x' }], valor_pago_centavos: 10000 }).acao === 'conferir');
  t('baixa: agendado nunca baixa', P.decidirBaixa({ situacao: 'agendado', despesa: desp() }).acao === 'nada');
  t('baixa: rejeitado avisa', P.decidirBaixa({ situacao: 'rejeitado', ocorrencias: [{ texto: 'Saldo insuficiente' }] }).acao === 'conferir');
  t('baixa: já baixada não faz nada', P.decidirBaixa({ situacao: 'confere', despesa: desp({ liquidada: true }), achados: [] }).acao === 'nada');
  t('baixa: sem código no sistema vai conferir', P.decidirBaixa({ situacao: 'divergente', despesa: desp(), achados: [{ tipo: 'sem_baixa' }, { tipo: 'sem_codigo_no_sistema' }], valor_pago_centavos: 10000 }).acao === 'conferir');
  // ---------- 7. comprovante ----------
  const pdf = P.comprovanteRetorno('Residencial Teste', { favorecido: 'EDP', data_pagamento: '2026-10-20', valor_centavos: 10250, ocorrencias: [{ codigo: '00', texto: 'Pagamento efetivado' }], lote: '0001', seq: 2, segmento: 'J', arquivo_hash: 'abc', data_arquivo: '2026-10-21' });
  t('comprovante é PDF com os dados do banco', E.ehPdf(pdf) && /R\$ 102,50/.test(pdf.toString('latin1')) && /Pagamento efetivado/.test(pdf.toString('latin1')) && /startxref/.test(pdf.toString('latin1')));
  t('comprovante do extrato', E.ehPdf(P.comprovanteExtrato('X', 'Conta movimento', { data: '2026-10-20', valor: -5000, descricao: 'DEB AUT EDP' })));
  // ---------- 8. dias úteis ----------
  t('páscoa 2026', Z.pascoa(2026) === '2026-04-05');
  t('feriados', !Z.diaUtil('2026-11-02') && !Z.diaUtil('2026-11-20') && !Z.diaUtil('2026-02-17') && !Z.diaUtil('2026-10-24') && Z.diaUtil('2026-10-23'));
  t('dias úteis até', Z.diasUteisAte('2026-10-23', '2026-10-27') === 2 && Z.diasUteisAte('2026-10-30', '2026-11-03') === 1 && Z.diasUteisAte('2026-10-23', '2026-10-23') === 0 && Z.diasUteisAte('2026-10-27', '2026-10-23') === -2);
  t('limite para lançar', Z.limiteParaLancar('2026-10-27') === '2026-10-23' && Z.limiteParaLancar('2026-11-04') === '2026-10-30');
  // ---------- 9. contas esperadas ----------
  const parc = (o) => Object.assign({ id_condominio_cond: '167', id_contato_con: '500', st_nome_con: 'EDP ESCELSA', id_forma_pag: '7', fl_liquidado_pdes: '1', dt_liquidacao_pdes: '', apropriacao: [{ st_conta_cont: '2.1.1', st_descricao_cont: 'Energia' }] }, o);
  let n = 1000;
  const hist = [];
  for (const [m, v] of [['2026-04', '850.10'], ['2026-05', '870.00'], ['2026-06', '820.00'], ['2026-07', '900.00'], ['2026-08', '880.00'], ['2026-09', '860.00']]) {
    hist.push(parc({ id_despesa_des: String(n), id_parcela_pdes: String(n++), dt_vencimento_pdes: sl(m + '-26'), vl_valor_pdes: v }));
    hist.push(parc({ id_contato_con: '600', st_nome_con: 'FORTE ELEVADORES', id_forma_pag: '0', id_despesa_des: String(n), id_parcela_pdes: String(n++), dt_vencimento_pdes: sl(m + '-10'), vl_valor_pdes: '1200.00', apropriacao: [{ st_conta_cont: '2.3.1' }] }));
  }
  hist.push(parc({ id_contato_con: '700', st_nome_con: 'AVULSO', id_despesa_des: '99', id_parcela_pdes: '99', dt_vencimento_pdes: sl('2026-09-02'), vl_valor_pdes: '50.00' }));
  // Outubro: o elevador chegou com valor fora do normal; a EDP não chegou.
  const out = parc({ id_contato_con: '600', st_nome_con: 'FORTE ELEVADORES', id_forma_pag: '0', fl_liquidado_pdes: '0', id_despesa_des: '2000', id_parcela_pdes: '2000', dt_vencimento_pdes: sl('2026-10-10'), vl_valor_pdes: '1500.00' });
  const esp = Z.aprender(hist.concat([out]), HOJE);
  t('aprende EDP e elevador, ignora avulso', esp.length === 2 && esp.some((e) => e.fornecedor === 'EDP ESCELSA' && e.dias[0] === 26 && e.tipo === 'concessionária' && e.valor_mediano === 86500) && !esp.some((e) => e.fornecedor === 'AVULSO'));
  const falt = Z.contasQueFaltam(esp, hist.concat([out]), HOJE, 'Buritis', new Set());
  const edp = falt.find((a) => a.codigo === 'conta_nao_chegou');
  t('avisa a conta que não chegou', edp && edp.texto === 'Conta de EDP ESCELSA do Buritis ainda não chegou e vence em 3 dias (dia 26/10/2026).' && edp.nivel === 'urgente' && edp.dias_uteis === 1 && edp.limite_lancar === '2026-10-22');
  t('ignorada não avisa', !Z.contasQueFaltam(esp, hist, HOJE, 'Buritis', new Set([edp.chave])).some((a) => a.chave === edp.chave));
  t('valor fora do normal', falt.some((a) => a.codigo === 'valor_fora_do_normal' && a.fornecedor === 'FORTE ELEVADORES'));
  t('chegou: não avisa', !Z.contasQueFaltam(esp, hist.concat([out, parc({ id_despesa_des: '3000', id_parcela_pdes: '3000', dt_vencimento_pdes: sl('2026-10-27'), vl_valor_pdes: '880.00' })]), HOJE, 'Buritis').some((a) => a.codigo === 'conta_nao_chegou'));
  t('atenção a mais de 2 dias úteis', Z.contasQueFaltam(esp, hist, '2026-10-20', 'B').find((a) => a.codigo === 'conta_nao_chegou').nivel === 'atencao');
  // ---------- 10. prazo das lançadas ----------
  const ab = (o) => Object.assign({ id_condominio_cond: '167', id_contato_con: '600', st_nome_con: 'FORN', id_forma_pag: '0', fl_liquidado_pdes: '0', dt_liquidacao_pdes: '', fl_remessastatus_pdes: '', vl_valor_pdes: '100.00', st_codigobarras_pdes: '' }, o);
  const pz = Z.prazos([
    ab({ id_parcela_pdes: '1', id_despesa_des: '1', dt_vencimento_pdes: sl('2026-10-27') }),
    ab({ id_parcela_pdes: '2', id_despesa_des: '2', dt_vencimento_pdes: sl('2026-10-27'), fl_remessastatus_pdes: '1' }),
    ab({ id_parcela_pdes: '3', id_despesa_des: '3', dt_vencimento_pdes: sl('2026-10-27'), id_forma_pag: '7' }),
    ab({ id_parcela_pdes: '4', id_despesa_des: '4', dt_vencimento_pdes: sl('2026-10-28') }),
    ab({ id_parcela_pdes: '5', id_despesa_des: '5', dt_vencimento_pdes: sl('2026-10-20') }),
    ab({ id_parcela_pdes: '6', id_despesa_des: '6', dt_vencimento_pdes: sl('2026-11-20') }),
  ], HOJE, new Map([['4', { enviado_em: 'x', para: 'síndico' }]]), 'Buritis');
  t('prazo: sem envio urgente', pz.some((a) => a.id_parcela === '1' && a.codigo === 'sem_envio_assinatura' && a.nivel === 'urgente'));
  t('prazo: remessa, débito e envio registrado não avisam', !pz.some((a) => ['2', '3', '4'].includes(a.id_parcela)));
  t('prazo: vencida em aberto', pz.some((a) => a.id_parcela === '5' && a.codigo === 'vencida_em_aberto'));
  t('prazo: longe não avisa', !pz.some((a) => a.id_parcela === '6'));
  t('lançada em cima do prazo', Z.lancadasEmCimaDoPrazo([ab({ id_parcela_pdes: '7', id_despesa_des: '7', dt_geracao_des: sl('2026-10-22'), dt_vencimento_pdes: sl('2026-10-23') }), ab({ id_parcela_pdes: '8', id_despesa_des: '8', dt_geracao_des: sl('2026-10-05'), dt_vencimento_pdes: sl('2026-10-23') })], HOJE).map((x) => x.id_parcela).join() === '7');
  // ---------- 11. casamento com o retorno e o extrato ----------
  const LB = linhaBoleto('2026-10-20', 10000, '4'.repeat(25));
  const pend = [
    ab({ id_parcela_pdes: '11', id_despesa_des: '11', dt_vencimento_pdes: sl('2026-10-20'), vl_valor_pdes: '100.00', st_codigobarras_pdes: LB, id_contabanco_cb: '823' }),
    ab({ id_parcela_pdes: '12', id_despesa_des: '12', dt_vencimento_pdes: sl('2026-10-21'), vl_valor_pdes: '80.00', id_forma_pag: '7', st_nome_con: 'CESAN', id_contabanco_cb: '823' }),
    ab({ id_parcela_pdes: '13', id_despesa_des: '13', dt_vencimento_pdes: sl('2026-10-21'), vl_valor_pdes: '95.00', id_forma_pag: '7', st_nome_con: 'EDP ESCELSA', id_contabanco_cb: '823' }),
  ];
  const ret = [
    { id: 1, id_superlogica: 167, arquivo_hash: 'h', lote: '0001', seq: 1, segmento: 'J', codigo_barras: E.barrasDaLinha(LB), data_pagamento: '2026-10-22', valor_centavos: 10200, valor_titulo_centavos: 10000, ocorrencias: [{ codigo: '00', texto: 'Pagamento efetivado' }] },
    { id: 2, id_superlogica: 167, arquivo_hash: 'h', lote: '0001', seq: 2, segmento: 'J', codigo_barras: E.barrasDaLinha(linhaBoleto('2026-10-25', 5000, '5'.repeat(25))), data_pagamento: '2026-10-25', valor_centavos: 5000, ocorrencias: [{ codigo: 'BD', texto: 'Agendado' }] },
  ];
  const pr = B.propostasRetorno(ret, pend, null);
  t('retorno: pago com juros vira baixa pronta', pr.length === 1 && pr[0].acao === 'baixar' && pr[0].id_parcela === '11' && pr[0].juros_centavos === 200 && pr[0].data === '2026-10-22' && pr[0].origem_ref === 'b1');
  const ext = [{ data: '2026-10-21', valor: -8000, descricao: 'DEB AUTOMATICO CESAN', fitid: 'F1' }, { data: '2026-10-21', valor: -9733, descricao: 'DEB AUT EDP ESCELSA', fitid: 'F2' }, { data: '2026-10-21', valor: 5000, descricao: 'CREDITO' }];
  const px = B.propostasExtrato('823', ext, pend, HOJE);
  t('extrato: débito automático exato baixa', px.some((x) => x.id_parcela === '12' && x.acao === 'baixar' && x.valor_pago_centavos === 8000 && x.data === '2026-10-21'));
  t('extrato: valor diferente com o nome vai conferir', px.some((x) => x.id_parcela === '13' && x.acao === 'conferir' && x.valor_pago_centavos === 9733 && x.juros_centavos === 233));
  t('extrato: boleto não baixa pelo extrato', !px.some((x) => x.id_parcela === '11'));

  // ---------- Parte 2: gravação com o Superlógica dublado ----------
  // Superlógica de mentira: guarda despesas e parcelas e responde como a API real (medido no 167).
  function superlogica(cfg) {
    const c = Object.assign({ falhar: {} }, cfg || {});
    const est = { parcelas: [], chamadas: [], arquivos: 0, desp: 307000, parc: 337000, fornecedores: new Map() };
    const corpoDe = (b) => Object.fromEntries(new URLSearchParams(b ? b.toString('utf8') : ''));
    const resp = (status, json) => ({ status, json });
    const cred = { pedir: async (m, cam, q, b, tipo) => {
      const f = /multipart/.test(String(tipo || '')) ? {} : corpoDe(b);
      est.chamadas.push({ m, cam, q, f });
      if (c.falhar[cam]) return c.falhar[cam];
      if (cam === 'arquivos/') return resp(200, [{ status: '200', data: { id_arquivo_arq: String(++est.arquivos + 659000) } }]);
      if (cam === 'despesas/') {
        const id = String(++est.desp);
        const n = Number(f.NM_PARCELAS || 1);
        const apro = []; for (let i = 0; f['APROPRIACAO[' + i + '][ST_CONTA_CONT]']; i++) apro.push({ st_conta_cont: f['APROPRIACAO[' + i + '][ST_CONTA_CONT]'], valor: Number(f['APROPRIACAO[' + i + '][VL_VALOR_PDES]']) });
        const tot = apro.reduce((s2, x) => s2 + x.valor, 0); apro.forEach((x) => { x.vl_valor_apro = (x.valor / tot).toFixed(11); delete x.valor; }); // fração, como o Superlógica devolve
        for (let i = 0; i < n; i++) {
          const k = 'DESPESA_PARCELA[' + i + ']';
          est.parcelas.push({ id_despesa_des: id, id_parcela_pdes: String(++est.parc), id_condominio_cond: f.ID_CONDOMINIO_COND, id_contato_con: f.ID_CONTATO_CON, st_nome_con: f.ST_NOME_CON,
            dt_vencimento_pdes: f[k + '[DT_VENCIMENTO_PDES]'] + ' 00:00:00', vl_valor_pdes: f[k + '[VL_VALOR_PDES]'], st_codigobarras_pdes: f[k + '[ST_CODIGOBARRAS_PDES]'] || '',
            fl_pixtipochave_pdes: f[k + '[FL_PIXTIPOCHAVE_PDES]'] || '', st_pixchave_pdes: c.semPix ? '' : (f[k + '[ST_PIXCHAVE_PDES]'] || ''), id_forma_pag: f.ID_FORMA_PAG, id_contabanco_cb: f.ID_CONTABANCO_CB,
            fl_liquidado_pdes: '0', dt_liquidacao_pdes: '', fl_remessastatus_pdes: '', apropriacao: apro, arquivos: c.semAnexo ? [] : [{ id_arquivo_arq: f['ARQUIVOS[0][ID_ARQUIVO_ARQ]'] }], vl_juros_pdes: '0.00', vl_multa_pdes: '0.00' });
        }
        return resp(200, [{ status: '200', msg: 'Sucesso.', data: { id_despesa_des: id } }]);
      }
      if (cam === 'despesas/anexar') { const p = est.parcelas.find((x) => x.id_parcela_pdes === String(q.ID_PARCELA_PDES)); if (p) p.arquivos.push({ id_arquivo_arq: q['ARQUIVOS[0][ID_ARQUIVO_ARQ]'] }); return resp(200, [{ status: '200' }]); }
      if (cam === 'arquivos/adicionaretiqueta') return resp(200, [{ status: '200' }]);
      if (cam === 'despesas/post') { const p = est.parcelas.find((x) => x.id_parcela_pdes === f.ID_PARCELA_PDES); if (p && !c.remessaNaoFica) p.fl_remessastatus_pdes = f.FL_REMESSASTATUS_PDES; return resp(200, [{ status: '200', msg: 'Parcela alterada.' }]); }
      if (cam === 'despesas/liquidar') {
        const p = est.parcelas.find((x) => x.id_parcela_pdes === f.ID_PARCELA_PDES);
        if (c.liquidarSemEfeito) return resp(504, null);
        if (p) Object.assign(p, { fl_liquidado_pdes: '1', dt_liquidacao_pdes: f.DT_LIQUIDACAO_PDES + ' 00:00:00', vl_juros_pdes: f.VL_JUROS_PDES, vl_multa_pdes: f.VL_MULTA_PDES, vl_valor_pdes: f.VL_PAGO, arquivos: p.arquivos.concat([{ id_arquivo_arq: f['ARQUIVOS[0][ID_ARQUIVO_ARQ]'] }]) });
        return resp(200, [{ status: '200', msg: 'Despesa(s) liquidada(s).' }]);
      }
      if (cam === 'fornecedores/') { if (c.fornecedorSemResposta) return resp(504, null); est.fornecedores.set(f.ST_CPF_CON, { id_contato_con: '90001', st_nome_con: f.ST_NOME_CON, st_cpf_con: f.ST_CPF_CON, favorecido_pix: f['FAVORECIDO_PIX[0][ST_CHAVE_PIX]'] ? [{ st_chave_pix: f['FAVORECIDO_PIX[0][ST_CHAVE_PIX]'] }] : [] }); return resp(200, [{ status: '200' }]); }
      return resp(404, null);
    } };
    const cliente = { get: async (rota, p) => {
      if (rota === 'despesas/index') {
        const ini = E.slParaIso(p.dtInicio), fim = E.slParaIso(p.dtFim);
        const l = est.parcelas.filter((x) => String(x.id_condominio_cond) === String(p.idCondominio) && E.slParaIso(x.dt_vencimento_pdes) >= ini && E.slParaIso(x.dt_vencimento_pdes) <= fim);
        return l.slice((p.pagina - 1) * 50, p.pagina * 50).map((x) => JSON.parse(JSON.stringify(x)));
      }
      if (rota === 'fornecedores/index') {
        if (p.pesquisa) { const f = est.fornecedores.get(String(p.pesquisa)); return f ? [f] : []; }
        if (p.id) return [...est.fornecedores.values()].filter((f) => f.id_contato_con === String(p.id)).concat(p.id === '68185' ? [{ id_contato_con: '68185', st_nome_con: 'BANCO DO BRASIL SA', st_cpf_con: '00000000000191' }] : []);
        return [];
      }
      if (rota === 'condominios/get') return p.pagina === 1 ? [{ id_condominio_cond: '167', st_fantasia_cond: 'Residencial Teste', id_planoconta_plc: '8', st_cnpj_cond: '' }, { id_condominio_cond: '136', st_fantasia_cond: 'Condomínio Casablanca', id_planoconta_plc: '8', st_cnpj_cond: '' }] : [];
      if (rota === 'planocontas') return [{ st_conta_cont: '2.2.1', st_descricao_cont: 'Tarifas' }, { st_conta_cont: '2.3.1', st_descricao_cont: 'Manutenção' }];
      if (rota === 'contabancos/index') return [{ id_condominio_cond: String(p.idCondominio), id_contabanco_cb: '823', fl_principal_cb: '1', st_descricao_cb: 'Conta movimento', dt_bloquearlancamentos_cb: cfg && cfg.bloqueio ? cfg.bloqueio : '' }];
      return [];
    } };
    return { est, cred, cliente };
  }
  E.limparCache();
  let S = superlogica();
  const pkA = P.conferirPacote({ valor: 1000, vencimento: '2026-11-10', forma_pag: 0, conta: '2.2.1' }, { parcelas: [{ vencimento: '2026-11-10', valor: 600, linha: L1 }, { vencimento: '2026-12-10', valor: 400, linha: L2 }], rateio: [{ conta: '2.2.1', valor: 700 }, { conta: '2.3.1', valor: 300 }], remessa: true }, PLANO, HOJE).ok;
  const dA = Object.assign({ id_superlogica: '167', id_fornecedor: '68185', nome_fornecedor: 'BB', tipo: 'boleto', documento: 'A', id_contabanco: '823' }, pkA);
  let rA = await P.lancarCompleto(S.cred, S.cliente, dA, pdf, 'a.pdf', 'application/pdf', HOJE);
  t('lançamento completo provado', rA.ok && rA.conferido && rA.rateio && rA.anexado && rA.parcelas.length === 2 && rA.parcelas.every((p) => p.remessa && p.remessa.ok));
  t('remessa marcada nas duas parcelas', S.est.parcelas.every((p) => p.fl_remessastatus_pdes === '1') && S.est.chamadas.filter((c) => c.cam === 'despesas/post').length === 2);
  S = superlogica({ remessaNaoFica: true });
  rA = await P.lancarCompleto(S.cred, S.cliente, dA, pdf, 'a.pdf', 'application/pdf', HOJE);
  t('remessa que não ficou é avisada', rA.ok && rA.parcelas.every((p) => p.remessa && !p.remessa.ok && /não ficou marcada/.test(p.remessa.msg)));
  S = superlogica({ falhar: { 'despesas/': { status: 504, json: null } } });
  rA = await P.lancarCompleto(S.cred, S.cliente, dA, pdf, 'a.pdf', 'application/pdf', HOJE);
  t('sem resposta fica incerto, sem marcar remessa', !rA.ok && rA.incerto && !S.est.chamadas.some((c) => c.cam === 'despesas/post'));
  S = superlogica({ falhar: { 'despesas/': { status: 206, json: [{ status: '500', msg: 'Erro: Chave BR Code inválida.' }] } } });
  rA = await P.lancarCompleto(S.cred, S.cliente, dA, pdf, 'a.pdf', 'application/pdf', HOJE);
  t('recusa clara (HTTP 206 com status 500)', !rA.ok && !rA.incerto && /BR Code/.test(rA.msg));
  S = superlogica({ semPix: true });
  rA = await P.lancarCompleto(S.cred, S.cliente, Object.assign({ id_superlogica: '167', id_fornecedor: '68185', tipo: 'nota', id_contabanco: '823' }, pkPix), pdf, 'b.pdf', 'application/pdf', HOJE);
  t('chave Pix que não ficou: sem prova', rA.ok && !rA.conferido && rA.parcelas[0].prova.pix === false);
  // lancarDaEntrada no formato da entrada
  S = superlogica();
  const rE = await P.lancarDaEntrada(S.cred, S.cliente, Object.assign({ id_superlogica: '167', id_fornecedor: '68185', nome_fornecedor: 'BB', tipo: 'nota', valor: 1000, vencimento: '2026-11-10', forma_pag: 12, id_contabanco: '823', pagar: { pix: { chave: '00.000.000/0001-91' }, rateio: [{ conta: '2.2.1', valor_centavos: 100000 }] } }), PLANO, pdf, 'c.pdf', 'application/pdf', HOJE);
  t('lançamento pela entrada', rE.ok && rE.conferido && rE.id_parcela && rE.prova.pix === true);
  const rE2 = await P.lancarDaEntrada(S.cred, S.cliente, { id_superlogica: '167', id_fornecedor: '68185', valor: 999, vencimento: '2026-11-10', forma_pag: 0, pagar: { rateio: [{ conta: '2.2.1', valor_centavos: 100000 }] } }, PLANO, pdf, 'c.pdf', 'application/pdf', HOJE);
  t('pacote que não bate com o documento não lança', !rE2.ok && !rE2.incerto && /soma das categorias/.test(rE2.msg));
  // baixa
  S = superlogica();
  await P.lancarCompleto(S.cred, S.cliente, Object.assign({}, dA, { remessa: false }), pdf, 'a.pdf', 'application/pdf', HOJE);
  const p0 = S.est.parcelas[0];
  const bx = { id_condominio: '167', id_parcela: p0.id_parcela_pdes, vencimento: '2026-11-10', data: '2026-10-22', hoje: HOJE, valor_pago_centavos: 60250, juros_centavos: 200, multa_centavos: 50, comprovante: pdf };
  let rb = await P.darBaixa(S.cred, S.cliente, bx);
  const liq = S.est.chamadas.find((c) => c.cam === 'despesas/liquidar');
  t('baixa provada com comprovante', rb.ok && rb.conferido && rb.prova.comprovante && rb.prova.juros && rb.prova.multa && rb.prova.data);
  t('baixa: corpo do liquidar', liq.f.DT_LIQUIDACAO_PDES === '10/22/2026' && liq.f.VL_PAGO === '602.50' && liq.f.VL_JUROS_PDES === '2.00' && liq.f.VL_MULTA_PDES === '0.50' && liq.f.VL_VALOR_PDES === '600.00' && liq.f.ID_CONTABANCO_CB === '823' && /^\d+$/.test(liq.f['ARQUIVOS[0][ID_ARQUIVO_ARQ]']));
  const antes = S.est.chamadas.length;
  rb = await P.darBaixa(S.cred, S.cliente, bx);
  t('baixa repetida não grava', !rb.ok && rb.ja_baixada && S.est.chamadas.length === antes);
  const p1 = S.est.parcelas[1];
  rb = await P.darBaixa(S.cred, S.cliente, Object.assign({}, bx, { id_parcela: p1.id_parcela_pdes, vencimento: '2026-12-10', valor_pago_centavos: 45000, juros_centavos: 0, multa_centavos: 0 }));
  t('valor que não fecha não grava', !rb.ok && /diferente/.test(rb.msg) && S.est.chamadas.length === antes);
  rb = await P.darBaixa(S.cred, S.cliente, Object.assign({}, bx, { id_parcela: p1.id_parcela_pdes, vencimento: '2026-12-10', valor_pago_centavos: 40000, juros_centavos: 0, multa_centavos: 0, bloqueio: '2026-10-31' }));
  t('mês fechado não grava', !rb.ok && /fechado/.test(rb.msg) && S.est.chamadas.length === antes);
  rb = await P.darBaixa(S.cred, S.cliente, Object.assign({}, bx, { id_parcela: p1.id_parcela_pdes, vencimento: '2026-12-10', valor_pago_centavos: 40000, juros_centavos: 0, multa_centavos: 0, data: '2026-10-30' }));
  t('data futura não grava', !rb.ok && /Data/.test(rb.msg));
  const S2 = superlogica({ liquidarSemEfeito: true });
  await P.lancarCompleto(S2.cred, S2.cliente, Object.assign({}, dA, { remessa: false }), pdf, 'a.pdf', 'application/pdf', HOJE);
  rb = await P.darBaixa(S2.cred, S2.cliente, Object.assign({}, bx, { id_parcela: S2.est.parcelas[0].id_parcela_pdes, valor_pago_centavos: 60000, juros_centavos: 0, multa_centavos: 0 }));
  t('liquidar sem resposta fica incerto', !rb.ok && rb.incerto);
  // fornecedor
  t('fornecedor: conferência', !!P.conferirFornecedor({ cnpj: '123', nome: 'X' }).erro && P.conferirFornecedor({ cnpj: '00.000.000/0001-91', nome: 'Banco', pix: { chave: 'a@b.com' } }).ok.pix.codigo === 4
    && !!P.conferirFornecedor({ cnpj: '00000000000191', nome: 'Banco', banco: { banco: '1', agencia: '1', conta: '1' } }).erro);
  const cf = P.corpoFornecedor('167', P.conferirFornecedor({ cnpj: '11.222.333/0001-81', nome: 'Fornecedor Teste', pix: { chave: '11.222.333/0001-81' }, banco: { banco: '756', agencia: '3010', conta: '12345-6' } }).ok);
  t('fornecedor: corpo', cf.ST_CPF_CON === '11222333000181' && cf['FAVORECIDO_PIX[0][FL_TIPOCHAVE_PIX]'] === 2 && cf.ST_BANCO_CON === '756' && cf.ID_CONDOMINIO_COND === '167');
  S = superlogica();
  E.limparCache();
  let rf = await P.cadastrarFornecedor(S.cred, S.cliente, '167', P.conferirFornecedor({ cnpj: '11.222.333/0001-81', nome: 'Fornecedor Teste', pix: { chave: 'f@exemplo.com' } }).ok);
  t('fornecedor cadastrado e relido', rf.ok && rf.id === '90001' && rf.pix_gravado === true);
  E.limparCache();
  rf = await P.cadastrarFornecedor(S.cred, S.cliente, '167', P.conferirFornecedor({ cnpj: '11.222.333/0001-81', nome: 'Outro' }).ok);
  t('fornecedor que já existe não grava de novo', rf.ok && rf.ja_existia && S.est.chamadas.filter((c) => c.cam === 'fornecedores/').length === 1);
  S = superlogica({ fornecedorSemResposta: true });
  E.limparCache();
  rf = await P.cadastrarFornecedor(S.cred, S.cliente, '167', P.conferirFornecedor({ cnpj: '11.222.333/0001-81', nome: 'X Teste' }).ok);
  t('fornecedor sem resposta fica incerto', !rf.ok && rf.incerto);

  // ---------- Parte 3: rotas ----------
  const express = require('express');
  const http = require('http');
  // Banco em memória com o pedaço do PostgREST que as rotas usam.
  function bancoMemoria() {
    const tab = { fin_pagar_baixas: [], fin_pagar_envios: [], fin_pagar_esperadas: [], fin_pagar_fornecedores: [], fin_juros_banco: [], fin_entrada: [] };
    let seq = 0;
    const filtrar = (linhas, qs) => linhas.filter((l) => [...qs.entries()].every(([k, v]) => {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
      const x = l[k] == null ? null : String(l[k]);
      if (v.startsWith('eq.')) return x === decodeURIComponent(v.slice(3));
      if (v.startsWith('neq.')) return x !== v.slice(4);
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(x);
      if (v === 'is.null') return x === null;
      if (v === 'not.is.null') return x !== null;
      return true;
    }));
    const unico = (t2, l) => {
      if (t2 === 'fin_pagar_baixas') return tab[t2].some((o) => (o.origem === l.origem && o.origem_ref === l.origem_ref) || (l.id_parcela != null && o.id_parcela === l.id_parcela && ['pronta', 'gravando', 'baixada', 'incerto'].includes(o.situacao) && ['pronta', 'gravando', 'baixada', 'incerto'].includes(l.situacao)));
      if (t2 === 'fin_pagar_envios') return tab[t2].some((o) => o.id_parcela === l.id_parcela);
      if (t2 === 'fin_pagar_esperadas') return tab[t2].some((o) => o.id_superlogica === l.id_superlogica && o.chave === l.chave);
      if (t2 === 'fin_pagar_fornecedores') return tab[t2].some((o) => o.cnpj === l.cnpj && ['pendente', 'gravando', 'incerto'].includes(o.situacao));
      return false;
    };
    const fn = async (m, caminho, corpo) => {
      const u = new URL('http://x' + caminho);
      const t2 = u.pathname.replace('/rest/v1/', '');
      if (!tab[t2]) return { status: 404, body: null };
      const qs = u.searchParams;
      if (m === 'GET') return { status: 200, body: JSON.parse(JSON.stringify(filtrar(tab[t2], qs))) };
      if (m === 'POST') {
        const l = Object.assign({}, corpo);
        if (unico(t2, l)) return { status: 409, body: null };
        if (t2 === 'fin_pagar_baixas') l.id = ++seq;
        if (t2 === 'fin_pagar_fornecedores') l.id = '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
        tab[t2].push(l);
        return { status: 201, body: [l] };
      }
      if (m === 'PATCH') { const l = filtrar(tab[t2], qs); l.forEach((x) => Object.assign(x, corpo)); return { status: 200, body: l }; }
      return { status: 405, body: null };
    };
    fn.tab = tab;
    return fn;
  }
  const banco = bancoMemoria();
  const eventos = [];
  const auditoria = { evento: (req, acao, det) => eventos.push({ acao, det, quem: req.user && req.user.sub }) };
  const politica = W.criarPoliticaEscrita({ env: () => ({}), auditar: (req, acao, det) => eventos.push({ acao, det }), condominioDaBase: async (id) => ({ 167: { nome: 'Residencial Teste' }, 136: { nome: 'Condomínio Casablanca' } }[id] || null) });
  const PERFIS = { ana: { email: 'ana@x', role: 'ANALISTA', permissoes: { entrada_documentos: { visivel: true, acoes: ['ver', 'lancar'] } } },
    bia: { email: 'bia@x', role: 'ANALISTA', permissoes: { entrada_documentos: { visivel: true, acoes: ['ver', 'lancar'] } } },
    gil: { email: 'gil@x', role: 'GERENTE', permissoes: { entrada_documentos: { visivel: true, acoes: ['ver', 'lancar'] } } },
    leo: { email: 'leo@x', role: 'ANALISTA', permissoes: { entrada_documentos: { visivel: true, acoes: ['ver'] } } } };
  S = superlogica();
  const app = express();
  app.use((req, res, next) => { req.user = { sub: req.headers['x-quem'] }; req.authMode = 'supabase'; next(); });
  const sim = async () => true;
  const R = require('../servico/rotas-pagar').registrar({
    app, express, requireAuth: (req, res, next) => next(), banco, exigirFinanceiro: sim, exigirLeituraSuperlogica: sim, exigirCarteira: sim, exigirEscopo: async () => ({ escopo: null }),
    escopoFinanceiro: async () => null, lerPerfil: async (id) => PERFIS[id] || null,
    podeModulo: (p, mod, acao) => !!(p && (p.role === 'GERENTE' || (p.permissoes[mod] && p.permissoes[mod].acoes.includes(acao)))), gruposCarteiras: async () => [],
    clienteSL: () => S.cliente, credSL: () => S.cred, politica, auditoria, conciliacao: null, obterBase: async () => ({ analistas: new Map([['167', 'Daiane']]) }), hoje: () => HOJE,
  });
  const srv = http.createServer(app).listen(0);
  const porta = srv.address().port;
  const chamar = (quem, m, url, corpo) => new Promise((ok) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const r = http.request({ port: porta, path: url, method: m, headers: Object.assign({ 'x-quem': quem }, dados ? { 'content-type': 'application/json', 'content-length': dados.length } : {}) }, (resp) => {
      const p = []; resp.on('data', (c) => p.push(c)); resp.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString()); } catch (e) { j = null; } ok({ st: resp.statusCode, j }); });
    });
    if (dados) r.write(dados);
    r.end();
  });
  // Despesa no 167 lançada pela Ana pelo Hub; o retorno do banco mostra o pagamento com R$ 2,00 a mais.
  E.limparCache();
  await P.lancarCompleto(S.cred, S.cliente, Object.assign({}, dA, { remessa: false }), pdf, 'a.pdf', 'application/pdf', HOJE);
  const pA = S.est.parcelas[0];
  banco.tab.fin_entrada.push({ id: 'e1', id_superlogica: 167, id_despesa: Number(pA.id_despesa_des), lancado_por: 'ana', status: 'lancado', resultado: { lancado_por_email: 'ana@x' } });
  banco.tab.fin_juros_banco.push({ id: 1, id_superlogica: 167, arquivo_hash: 'h', lote: '0001', seq: 1, segmento: 'J', codigo_barras: E.barrasDaLinha(L1), data_pagamento: '2026-10-22', valor_centavos: 60200, valor_titulo_centavos: 60000, ocorrencias: [{ codigo: '00', texto: 'Pagamento efetivado' }], enviado_por: 'x', enviado_por_email: 'x@x' });
  let r = await chamar('leo', 'POST', '/api/pagar/condominio/167/procurar', {});
  t('rota: quem só vê não procura', r.st === 403);
  r = await chamar('ana', 'POST', '/api/pagar/condominio/167/procurar', {});
  t('rota: procurar acha o pagamento', r.st === 200 && r.j.novas === 1 && r.j.prontas === 1);
  const bxl = banco.tab.fin_pagar_baixas[0];
  t('rota: proposta com analista e quem lançou', bxl.situacao === 'pronta' && bxl.analista === 'Daiane' && bxl.lancado_por === 'ana' && Number(bxl.juros) === 2 && !bxl.detalhe.linha_banco.enviado_por);
  r = await chamar('ana', 'POST', '/api/pagar/condominio/167/procurar', {});
  t('rota: procurar de novo não repete', r.j.novas === 0 && banco.tab.fin_pagar_baixas.length === 1);
  r = await chamar('ana', 'POST', '/api/pagar/condominio/167/baixar', { ids: [bxl.id] });
  t('rota: quem lançou não dá a baixa', r.st === 409 && /Quem lançou/.test(r.j.detalhe) && !S.est.chamadas.some((c) => c.cam === 'despesas/liquidar'));
  r = await chamar('bia', 'POST', '/api/pagar/condominio/167/baixar', { ids: [bxl.id] });
  t('rota: outra pessoa baixa no 167 sem janela', r.st === 200 && r.j.resultados[0].ok && bxl.situacao === 'baixada' && bxl.baixado_por === 'bia@x' && S.est.parcelas[0].fl_liquidado_pdes === '1' && S.est.parcelas[0].vl_juros_pdes === '2.00');
  t('rota: auditoria da gravação', eventos.some((e) => e.acao === 'gravacao_superlogica' && e.det.operacao === 'pagar_baixa' && e.det.ok));
  r = await chamar('bia', 'POST', '/api/pagar/condominio/136/baixar', { ids: [1] });
  t('rota: outro condomínio bloqueado pela política', r.st === 423 && r.j.erro === 'gravacao_bloqueada');
  // Rotina do sistema: retorno novo de outra parcela no 167 baixa sozinho (condomínio de teste).
  banco.tab.fin_juros_banco.push({ id: 2, id_superlogica: 167, arquivo_hash: 'h2', lote: '0001', seq: 1, segmento: 'J', codigo_barras: E.barrasDaLinha(L2), data_pagamento: '2026-10-22', valor_centavos: 40000, ocorrencias: [{ codigo: '00', texto: 'Pagamento efetivado' }] });
  const rot = await R.rodarRotina();
  const bx2 = banco.tab.fin_pagar_baixas.find((x) => x.origem_ref === 'b2');
  t('rotina: baixa sozinha no 167', rot.condominios >= 1 && bx2 && bx2.situacao === 'baixada' && bx2.baixado_por === 'sistema' && S.est.parcelas[1].fl_liquidado_pdes === '1');
  // Conferir: pagamento a maior alto vai para conferir; a pessoa separa juros e multa.
  await P.lancarCompleto(S.cred, S.cliente, Object.assign({}, dA, { documento: 'C', parcelas: [{ vencimento: '2026-10-20', valor_centavos: 10000, linha: LB }], rateio: [{ conta: '2.2.1', valor_centavos: 10000 }], remessa: false }), pdf, 'c.pdf', 'application/pdf', HOJE);
  const pC = S.est.parcelas[S.est.parcelas.length - 1];
  banco.tab.fin_juros_banco.push({ id: 3, id_superlogica: 167, arquivo_hash: 'h3', lote: '0001', seq: 1, segmento: 'J', codigo_barras: E.barrasDaLinha(LB), data_pagamento: '2026-10-22', valor_centavos: 12000, valor_titulo_centavos: 10000, ocorrencias: [{ codigo: '00', texto: 'Pagamento efetivado' }] });
  await chamar('bia', 'POST', '/api/pagar/condominio/167/procurar', {});
  const bx3 = banco.tab.fin_pagar_baixas.find((x) => x.origem_ref === 'b3');
  t('rota: acréscimo alto fica para conferir', bx3 && bx3.situacao === 'conferir');
  r = await chamar('bia', 'POST', '/api/pagar/baixas/' + bx3.id + '/conferir', { juros: '15,00', multa: '2,00' });
  t('rota: juros e multa precisam fechar', r.st === 400 && /diferença/.test(r.j.detalhe));
  r = await chamar('bia', 'POST', '/api/pagar/baixas/' + bx3.id + '/conferir', { juros: '18,00', multa: '2,00' });
  t('rota: conferida e baixada', r.st === 200 && bx3.situacao === 'baixada' && pC.vl_juros_pdes === '18.00' && pC.vl_multa_pdes === '2.00');
  // Envio para assinatura e esperadas
  await chamar('bia', 'GET', '/api/pagar/condominio/167');
  await new Promise((ok) => setTimeout(ok, 50));
  r = await chamar('bia', 'GET', '/api/pagar/condominio/167');
  t('rota: ficha do condomínio', r.st === 200 && r.j.gravacao === 'livre' && Array.isArray(r.j.baixas) && r.j.baixas.length === 3);
  r = await chamar('bia', 'POST', '/api/pagar/condominio/167/envio', { id_parcela: pC.id_parcela_pdes, para: 'presidente' });
  t('rota: envio só para síndico ou síndico e subsíndico', r.st === 400);
  r = await chamar('bia', 'POST', '/api/pagar/condominio/167/envio', { id_parcela: pC.id_parcela_pdes, para: 'síndico e subsíndico' });
  t('rota: envio registrado', r.st === 200 && banco.tab.fin_pagar_envios.length === 1);
  r = await chamar('bia', 'PUT', '/api/pagar/condominio/167/esperadas/f500', { ignorar: true });
  t('rota: ignorar pede motivo', r.st === 400);
  r = await chamar('bia', 'PUT', '/api/pagar/condominio/167/esperadas/f500', { ignorar: true, motivo: 'Contrato encerrado' });
  t('rota: esperada ignorada', r.st === 200 && banco.tab.fin_pagar_esperadas[0].ignorada === true);
  r = await chamar('bia', 'GET', '/api/pagar/analistas');
  t('rota: por analista', r.st === 200 && r.j.analistas[0].analista === 'Daiane' && r.j.analistas[0].baixadas_sistema_7d === 1 && r.j.analistas[0].baixadas_pessoa_7d === 2);
  // Pacote no rascunho
  banco.tab.fin_entrada.push({ id: '11111111-1111-4111-8111-111111111111', status: 'rascunho', id_superlogica: 167, dados: { valor: 1000, vencimento: '2026-11-10', forma_pag: 0, conta: null } });
  r = await chamar('bia', 'PUT', '/api/pagar/entrada/11111111-1111-4111-8111-111111111111/completo', { parcelas: [{ vencimento: '2026-11-10', valor: 600, linha: L1 }, { vencimento: '2026-12-10', valor: 500 }] });
  t('rota: pacote errado recusa', r.st === 400 && /soma/.test(r.j.detalhe));
  r = await chamar('bia', 'PUT', '/api/pagar/entrada/11111111-1111-4111-8111-111111111111/completo', { parcelas: [{ vencimento: '2026-11-10', valor: 600, linha: L1 }, { vencimento: '2026-12-10', valor: 400, linha: L2 }], rateio: [{ conta: '2.2.1', valor: 700 }, { conta: '2.3.1', valor: 300 }], remessa: true });
  const rasc = banco.tab.fin_entrada.find((x) => x.status === 'rascunho');
  t('rota: pacote guardado no rascunho', r.st === 200 && rasc.dados.pagar.parcelas.length === 2 && rasc.dados.conta === '2.2.1' && rasc.dados.pagar.remessa === true);
  // Fornecedor novo: Ana pede, Ana não aprova, Bia (analista) não aprova, Gil (gerente) aprova com a confirmação.
  r = await chamar('ana', 'POST', '/api/pagar/fornecedores', { id_superlogica: '167', cnpj: '11.222.333/0001-81', nome: 'Fornecedor Teste', pix: { chave: 'f@exemplo.com' } });
  t('rota: pedido de fornecedor', r.st === 200);
  const pedido = banco.tab.fin_pagar_fornecedores[0];
  r = await chamar('bia', 'POST', '/api/pagar/fornecedores/' + pedido.id + '/aprovar', { confirmado_como: 'telefone da nota' });
  t('rota: analista não aprova', r.st === 403);
  PERFIS.ana.role = 'GERENTE';
  r = await chamar('ana', 'POST', '/api/pagar/fornecedores/' + pedido.id + '/aprovar', { confirmado_como: 'telefone da nota' });
  t('rota: quem pediu não aprova', r.st === 403 && /Quem pediu/.test(r.j.detalhe));
  PERFIS.ana.role = 'ANALISTA';
  r = await chamar('gil', 'POST', '/api/pagar/fornecedores/' + pedido.id + '/aprovar', {});
  t('rota: aprovar com Pix pede a confirmação', r.st === 400);
  E.limparCache();
  r = await chamar('gil', 'POST', '/api/pagar/fornecedores/' + pedido.id + '/aprovar', { confirmado_como: 'Liguei no telefone da nota e falei com o Carlos' });
  t('rota: fornecedor gravado', r.st === 200 && r.j.id_contato === '90001' && pedido.situacao === 'gravado' && pedido.aprovado_por_email === 'gil@x');
  r = await chamar('ana', 'POST', '/api/pagar/fornecedores', { id_superlogica: '167', cnpj: '11.222.333/0001-81', nome: 'Fornecedor Teste' });
  t('rota: fornecedor que já existe não vira pedido', r.st === 409);
  r = await chamar('bia', 'GET', '/api/pagar/fornecedores');
  t('rota: analista vê só o tipo da chave Pix', r.st === 200 && r.j.itens[0].pix && r.j.itens[0].pix.tipo === 'Email' && r.j.itens[0].pix.chave === undefined);
  r = await chamar('gil', 'GET', '/api/pagar/fornecedores');
  t('rota: gestor ou gerente vê a chave completa', r.st === 200 && r.j.itens[0].pix.chave === 'f@exemplo.com');
  srv.close();

  // Textos de tela sem hífen ou travessão como pontuação e sem citar fornecedor de leitura automática.
  const fs = require('fs');
  const tela = fs.readFileSync(require('path').join(__dirname, '../public/contas-pagar.js'), 'utf8');
  const textos = (tela.match(/'[^'\n]{12,}'/g) || []).filter((s) => / [a-zà-ú]/i.test(s));
  t('tela sem travessão', !/[–—]/.test(tela) && !textos.some((s) => / - /.test(s)));
  t('tela sem citar leitura automática', !/\b(IA|intelig[eê]ncia artificial|Claude|Anthropic|OpenAI)\b/.test(tela));

  console.log('\n' + ok + ' ok, ' + falhou + ' falharam');
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.log('ERRO ' + (e && e.stack)); process.exit(1); });
