// Teste unitario DETERMINISTICO da correcao cirurgica (corrigirPlaceholdersDeliberacao).
// Chama a funcao real do server.js direto, com atas + transcricoes CONTROLADAS. Sem API,
// sem LLM, sem rede. Prova o mecanismo dos FIX 1/2/3/4 em segundos.
//   node scripts/ata-harness/cirurgica-unit-test.cjs   (rodar da raiz do repo)
const { corrigirPlaceholdersDeliberacao } = require('../../server.js');

let ok = 0, fail = 0;
function check(nome, cond, detalhe) {
  if (cond) { ok++; console.log(`  PASS  ${nome}`); }
  else { fail++; console.log(`  FAIL  ${nome}  -> ${detalhe}`); }
}
function run(nome, ata, transcricao) {
  const r = corrigirPlaceholdersDeliberacao(ata, transcricao);
  console.log(`\n===== ${nome} =====`);
  console.log('  preenchidos=' + JSON.stringify(r.preenchidos) + ' ambiguos=' + r.ambiguos.length);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────
// CASO A (FIX 1 + FIX 2): R$ 4.100 so num "[valor a confirmar]" em contexto Gilvania
// (entidade recorrente 5x na ata, df>2), valor AUSENTE do resto. Fala com voto contado
// E aprovacao nao hipotetica em ocorrencias diferentes (exige agregacao). DEVE preencher.
const falaA = 'Passando ao projeto tecnico. Quem e a favor da empresa Gilvania Reis no valor de R$4.100, levanta a plaquinha. Foram 17 votos a favor do primeiro orcamento. Entao aprovado pela maioria a contratacao da empresa Gilvania Reis no valor de R$4.100, o pagamento sai do saldo em conta.';
const ataA = 'A empresa Gilvania Reis apresentou proposta ao condominio. Discutiu-se a proposta da Gilvania Reis em plenario. Os condominos analisaram a oferta da Gilvania Reis com atencao. Aprovou-se a contratacao da empresa Gilvania Reis no valor de [valor a confirmar] para o projeto executivo. A Gilvania Reis ficara responsavel pela emissao da ART.';
const rA = run('CASO A (FIX 1+2, entidade recorrente, gatilho forte)', ataA, falaA);
check('A: preencheu o placeholder com R$ 4.100,00', rA.ata.includes('R$ 4.100,00'), 'nao inseriu 4.100');
check('A: nao restou [valor a confirmar]', !rA.ata.includes('[valor a confirmar]'), 'sobrou placeholder');
check('A: reportou 1 preenchido', rA.preenchidos.length === 1, 'preenchidos=' + rA.preenchidos.length);

// CASO A-CONTROLE: MESMA ata, mas fala SEM voto/aprovacao (contexto fraco). Sem gatilho
// forte, "Gilvania" (df>2) e rejeitada pela regra de raridade. NAO deve preencher. Prova
// que quem dispensa o df<=2 e o gatilho forte, nao a agregacao sozinha.
const falaA_fraco = 'A empresa Gilvania Reis no valor de R$4.100 apresentou seu orcamento para o projeto, conforme material entregue aos presentes.';
const rAc = run('CASO A-CONTROLE (mesmo caso, contexto FRACO sem voto/aprovacao)', ataA, falaA_fraco);
check('A-ctrl: NAO preencheu (df>2 sem gatilho forte)', rAc.ata.includes('[valor a confirmar]') && !rAc.ata.includes('R$ 4.100,00'), 'preencheu indevidamente');
check('A-ctrl: zero preenchidos', rAc.preenchidos.length === 0, 'preenchidos=' + rAc.preenchidos.length);

// CASO B (FIX 3): valor errado colado "R$ 3.519,00 [valor a confirmar]". DEVE apagar o
// errado e escrever o certo (R$ 3.519,59), sem grudar dois numeros. Ancora rara "sintetica".
const falaB = 'Quem e a favor com piso grama sintetica nesse total de R$3.519,59, levanta a plaquinha, foram 3 votos a favor da grama.';
const ataB = 'Passou-se a discussao dos pisos. Sobre a opcao de grama sintetica, o sindico informou que, com custo total estimado de R$ 3.519,00 [valor a confirmar], a obra seria concluida em trinta dias.';
const rB = run('CASO B (FIX 3, valor errado colado antes do placeholder)', ataB, falaB);
check('B: inseriu R$ 3.519,59', rB.ata.includes('R$ 3.519,59'), 'nao inseriu 3.519,59');
check('B: apagou o R$ 3.519,00 errado', !rB.ata.includes('R$ 3.519,00'), 'manteve o valor errado');
check('B: nao grudou dois numeros', !/R\$ 3\.519,00\s*R\$ 3\.519,59/.test(rB.ata), 'numeros grudados');
check('B: nao restou [valor a confirmar]', !rB.ata.includes('[valor a confirmar]'), 'sobrou placeholder');

// CASO C (FIX 4, questao a): valor em HEDGE no mesmo texto ("mencionado como R$ 4.100,00").
// Antes (falha conhecida): canonAta.has bloqueava o candidato e o placeholder NUNCA era
// preenchido. Agora, como a UNICA ocorrencia de 4.100 na ata e hedge (nenhuma firme), o
// valor volta a ser candidato e DEVE preencher — o preenchimento so muda o placeholder,
// a anotacao entre parenteses continua igual (nao e reescrita).
const falaC = falaA; // mesma fala forte
const ataC = 'A empresa Gilvania Reis apresentou proposta. Discutiu-se a Gilvania Reis. Aprovou-se a contratacao da Gilvania Reis no valor de [valor a confirmar] para o projeto (o valor foi mencionado como R$ 4.100,00 na apresentacao inicial). A Gilvania Reis emitira ART.';
const rC = run('CASO C (FIX 4: hedge no mesmo texto agora preenche)', ataC, falaC);
check('C: preencheu o placeholder com R$ 4.100,00', rC.ata.includes('R$ 4.100,00'), 'nao inseriu 4.100');
check('C: nao restou [valor a confirmar]', !rC.ata.includes('[valor a confirmar]'), 'sobrou placeholder');
check('C: reportou pelo menos 1 preenchido', rC.preenchidos.length >= 1, 'preenchidos=' + rC.preenchidos.length);

// CASO D (FIX 4, questao b — anti-ruido): valor HIPOTETICO ("caso aprovem, sairia R$ X").
// Antes: "aprovem" dentro de "caso voces aprovem" vazava pelo _CTX_DELIBERACAO.test puro e
// pela ancora rara "reforma"/"estrutura" (unica frase da ata, df=1). Agora NAO deve preencher.
const falaD = 'Caso voces aprovem esse item hipotetico de reforma, sairia algo em torno de R$ 9.999,00 para a estrutura, mas e so uma estimativa preliminar.';
const ataD = 'Sobre a reforma hipotetica da estrutura, o sindico comentou que o valor seria de [valor a confirmar], ainda sem definicao dos presentes.';
const rD = run('CASO D (anti-ruido: valor hipotetico condicional, vazamento fechado)', ataD, falaD);
check('D: NAO preencheu valor hipotetico', rD.ata.includes('[valor a confirmar]') && rD.preenchidos.length === 0, 'preencheu ruido: ' + JSON.stringify(rD.preenchidos));

// CASO D2 (anti-ruido limpo): valor de EXEMPLO sem nenhuma palavra de deliberacao.
const falaD2 = 'A representante informou que esse modelo de equipamento custa cerca de R$ 8.888,00 no mercado atualmente, so a titulo de referencia.';
const ataD2 = 'Foi citado que equipamentos de mercado custam em torno de [valor a confirmar], sem relacao com a deliberacao.';
const rD2 = run('CASO D2 (anti-ruido: valor de exemplo, sem deliberacao)', ataD2, falaD2);
check('D2: NAO preencheu valor de exemplo', rD2.ata.includes('[valor a confirmar]') && rD2.preenchidos.length === 0, 'preencheu exemplo: ' + JSON.stringify(rD2.preenchidos));

// ─────────────────────────────────────────────────────────────────────────
// CASOS NOVOS (FIX 4)
// ─────────────────────────────────────────────────────────────────────────

// CASO E (o mais importante — cenario real Enseada R$ 2.073 vs R$ 2.071): hedge com DOIS
// valores CONFLITANTES pro mesmo item. NUNCA pode escolher um dos dois: fica [a confirmar]
// e reporta em ambiguos. Prova que a regra 1 conserta o claro (CASO C) e a regra 2 (casaram
// > 1 fica ambiguo) sinaliza o conflito real, sem chutar.
const ataE = 'Sobre a taxa condominial extraordinaria aprovada em assembleia, ficou definido que a taxa no valor de [valor a confirmar] (mencionada como R$ 2.073,00 em um momento e como R$ 2.071,00 em outro, sem resolucao) seria cobrada dos condominos a partir do proximo mes.';
const falaE = 'Quem e a favor da taxa condominial extraordinaria no valor de R$2.073, levanta a plaquinha. Foram 12 votos a favor da taxa extraordinaria. Entao aprovada a taxa condominial extraordinaria, ainda que no sistema o valor tenha aparecido como R$2.071, tambem aprovada dessa forma pela maioria dos presentes.';
const rE = run('CASO E (FIX 4: hedge com dois valores conflitantes, nunca escolhe)', ataE, falaE);
check('E: continua [valor a confirmar]', rE.ata.includes('[valor a confirmar]'), 'preencheu quando deveria ficar ambiguo');
check('E: zero preenchidos', rE.preenchidos.length === 0, 'preenchidos=' + JSON.stringify(rE.preenchidos));
check('E: reportou ambiguo com os 2 candidatos (2073 e 2071)', rE.ambiguos.length === 1 && rE.ambiguos[0].candidatos.length === 2 && rE.ambiguos[0].candidatos.includes(2073) && rE.ambiguos[0].candidatos.includes(2071), 'ambiguos=' + JSON.stringify(rE.ambiguos));

// CASO F (GUARDA DE REGRESSAO): valor escrito de forma FIRME em outro ponto da ata (nao
// hedge) continua BLOQUEADO pro placeholder de outra entidade, mesmo com fala confirmando
// aquele valor. O bloqueio original (canonAta.has) NUNCA pode ser removido pra valor firme.
const ataF = 'Ficou registrado que a taxa extra para reforma do salao de festas foi fixada em R$ 3.600,00 conforme aprovado anteriormente. Em outro trecho da ata, consta que o valor da taxa extra para o salao de festas segue definido em [valor a confirmar], conforme deliberado nesta assembleia.';
const falaF = 'Quem e a favor da taxa extra para reforma do salao de festas no valor de R$3.600, levanta a plaquinha. Foram 15 votos a favor. Entao aprovada a taxa extra para o salao de festas no valor de R$3.600 pela maioria dos presentes.';
const rF = run('CASO F (guarda de regressao: valor FIRME na ata continua bloqueado)', ataF, falaF);
check('F: NAO preencheu (valor firme continua bloqueado)', rF.ata.includes('[valor a confirmar]') && rF.preenchidos.length === 0, 'preencheu valor firme indevidamente: ' + JSON.stringify(rF.preenchidos));

// CASO G (padrao Casablanca run1 — hedge SEM parenteses): "indicado como R$ X e mencionado
// tambem como R$ Y [valor a confirmar]". Prova que a deteccao de hedge NAO depende de
// parenteses. So R$ 10.900 e falado na deliberacao (R$ 10.000 nem aparece na fala, entao
// nunca vira candidato) — o placeholder deve preencher exatamente com R$ 10.900,00.
const ataG = 'Quanto ao contrato de manutencao da bomba centrifuga, o fornecedor apresentou valor indicado como R$ 10.900,00 e mencionado tambem como R$ 10.000,00 [valor a confirmar], conforme votacao dos condominos presentes.';
const falaG = 'Quem e a favor do contrato de manutencao da bomba centrifuga pelo valor de R$10.900, levanta a plaquinha. Foram 20 votos a favor da bomba centrifuga. Entao aprovado o contrato de manutencao da bomba centrifuga no valor de R$10.900 pela maioria.';
const rG = run('CASO G (FIX 4: hedge SEM parenteses, padrao Casablanca run1)', ataG, falaG);
check('G: preencheu R$ 10.900,00', rG.ata.includes('R$ 10.900,00'), 'nao inseriu 10.900');
check('G: nao restou [valor a confirmar]', !rG.ata.includes('[valor a confirmar]'), 'sobrou placeholder');
check('G: reportou 1 preenchido com canon 10900', rG.preenchidos.length === 1 && rG.preenchidos[0].canon === 10900, 'preenchidos=' + JSON.stringify(rG.preenchidos));

console.log(`\n==================\nRESULTADO: ${ok} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
