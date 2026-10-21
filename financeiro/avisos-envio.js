// T39: ponto de extensão do envio dos avisos para fora do Hub (e-mail, WhatsApp ou outro canal).
// DESLIGADO de propósito: o Matheus ainda vai escolher o canal. Este arquivo não chama rede, não lê
// variável de ambiente e não guarda contato de ninguém. Os avisos ficam só dentro do Hub (card "Seu dia").
// Para ligar no futuro (só depois da decisão do Matheus, registrada no PLANO):
//   1. implementar o canal escolhido numa função enviar(resumo) dentro de CANAIS;
//   2. trocar CANAL_ESCOLHIDO para o nome do canal;
//   3. revisão obrigatória (dado de condomínio saindo do Hub) e teste só com destinatário de teste.
'use strict';

const CANAL_ESCOLHIDO = null;
const CANAIS = {};

function canalAtivo() {
  return CANAL_ESCOLHIDO && typeof CANAIS[CANAL_ESCOLHIDO] === 'function' ? CANAL_ESCOLHIDO : null;
}

// Chamado depois de cada geração. Hoje sempre devolve { enviado: false }.
async function enviarResumo(resumo) {
  const canal = canalAtivo();
  if (!canal) return { enviado: false, motivo: 'canal_nao_escolhido' };
  return CANAIS[canal](resumo);
}

module.exports = { enviarResumo, canalAtivo };
