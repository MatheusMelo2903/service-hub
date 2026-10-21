// ============================================================
// RELATÓRIO MENSAL DO SÍNDICO (T13): PDF montado no navegador (jsPDF + fonte Arimo)
// com os dados de /api/condominio/:id/relatorio-mensal (só leitura no Superlógica).
// Seções: resumo do caixa, saldo por conta, receitas e despesas do mês, inadimplência,
// contas a pagar em 30 dias e alertas abertos. O que não veio do Superlógica sai como
// "não disponível"; nada é estimado.
// ============================================================

function relPreencherMeses() {
  var sel = document.getElementById('rel-mes');
  if (!sel || sel.options.length) return;
  var nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  // Data de Brasília (igual ao servidor) e sempre dia 1, sem estouro de fim de mês.
  var agora = new Date(Date.now() - 3 * 3600 * 1000);
  var base = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
  for (var i = 0; i < 24; i++) {
    var d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    var o = document.createElement('option');
    o.value = y + '-' + String(m).padStart(2, '0');
    o.textContent = nomes[m - 1] + '/' + y + (i === 0 ? ' (em andamento)' : '');
    if (i === 1) o.selected = true; // padrão: último mês fechado
    sel.appendChild(o);
  }
}

function relBRL(v) { return v == null ? 'não disponível' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

async function relatorioSindicoBaixar() {
  var cond = (typeof getCondominioAtivo === 'function') ? getCondominioAtivo() : null;
  if (!cond || !cond.id_superlogica) { toast('Selecione um condomínio com código do Superlógica', 'err'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Gerador de PDF não carregou. Recarregue a página.', 'err'); return; }
  var mes = (document.getElementById('rel-mes') || {}).value || '';
  var bt = document.getElementById('rel-btn'); var t0 = bt.textContent;
  bt.disabled = true; bt.textContent = 'Montando relatório...';
  try {
    var r = await apiAuthFetch('/api/condominio/' + encodeURIComponent(cond.id_superlogica) + '/relatorio-mensal' + (mes ? '?mes=' + encodeURIComponent(mes) : ''));
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.detalhe || ('Falha ' + r.status));
    if ((getCondominioAtivo() || {}).id_superlogica !== cond.id_superlogica) return; // trocou no meio
    var doc = relMontarPDF(d);
    var pm = String(d.mes || '').split('-');
    var nomeArq = 'Relatorio do Sindico ' + (d.condominio && d.condominio.nome ? d.condominio.nome : cond.nome) + ' ' + (pm.length === 2 ? pm[1] + ' ' + pm[0] : '') + '.pdf';
    doc.save(nomeArq.replace(/[\\/:*?"<>|]/g, ' '));
    if (d.falhas && d.falhas.length) toast('Relatório gerado. Não foi possível ler: ' + d.falhas.join(', ') + ' (sai como não disponível).', 'warn');
    else toast('Relatório baixado', 'ok');
  } catch (e) { toast('Não foi possível gerar o relatório: ' + e.message, 'err'); }
  finally { bt.disabled = false; bt.textContent = t0; }
}

// Desenha o PDF (A4 retrato, mm). Funções pequenas de layout com quebra de página.
function relMontarPDF(d) {
  var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  var F = 'Arimo';
  try { doc.setFont(F, 'normal'); } catch (e) { F = 'helvetica'; }
  var AZUL = [31, 78, 121], CINZA = [110, 110, 110], ML = 15, LARG = 180, ALT = 297, y = 15;
  var nomesMes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var mm = String(d.mes || '').split('-');
  var rotuloMes = mm.length === 2 ? nomesMes[+mm[1] - 1] + ' de ' + mm[0] : d.mes;

  function quebra(h) { if (y + h > ALT - 18) { doc.addPage(); y = 18; } }
  function texto(t, x, opt) { doc.text(String(t == null ? '' : t), x, y, opt || {}); }
  function titulo(t) {
    quebra(16); y += 4;
    doc.setFont(F, 'bold'); doc.setFontSize(12); doc.setTextColor.apply(doc, AZUL); texto(t, ML);
    doc.setDrawColor.apply(doc, AZUL); doc.setLineWidth(0.4); doc.line(ML, y + 1.5, ML + LARG, y + 1.5);
    y += 7; doc.setTextColor(30, 30, 30); doc.setFont(F, 'normal'); doc.setFontSize(9.5);
  }
  function linha(esq, dir, opt) {
    opt = opt || {};
    doc.setFont(F, opt.negrito ? 'bold' : 'normal'); // fonte antes de medir a quebra
    var partes = doc.splitTextToSize(String(esq), (dir != null ? LARG - 45 : LARG) - (opt.recuo || 0));
    quebra(partes.length * 4.6 + 1);
    if (opt.cinza) doc.setTextColor.apply(doc, CINZA);
    doc.text(partes, ML + (opt.recuo || 0), y);
    if (dir != null) doc.text(String(dir), ML + LARG, y, { align: 'right' });
    doc.setTextColor(30, 30, 30); doc.setFont(F, 'normal');
    y += partes.length * 4.6;
  }
  function nd(msg) { linha(msg || 'Não disponível (o Superlógica não respondeu esta parte).', null, { cinza: true }); }

  // Cabeçalho
  doc.setFillColor.apply(doc, AZUL); doc.rect(0, 0, 210, 30, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont(F, 'bold'); doc.setFontSize(15);
  doc.text('Relatório mensal do síndico', ML, 13);
  doc.setFontSize(10.5); doc.setFont(F, 'normal');
  doc.text(doc.splitTextToSize(String((d.condominio && d.condominio.nome) || ''), LARG)[0] || '', ML, 20);
  doc.text(rotuloMes + (d.mes_fechado ? '' : ' (mês em andamento)'), ML, 25.5);
  doc.setTextColor(30, 30, 30);
  y = 37; doc.setFontSize(9);
  var cab = [];
  if (d.condominio && d.condominio.cnpj) cab.push('CNPJ ' + d.condominio.cnpj);
  if (d.condominio && d.condominio.sindico) cab.push('Síndico(a): ' + d.condominio.sindico);
  if (cab.length) linha(cab.join('   ·   '), null, { cinza: true });
  if (d.condominio && d.condominio.endereco) linha(d.condominio.endereco, null, { cinza: true });

  // 1. Resumo do caixa
  var dem = d.demonstrativo;
  titulo('1. Resumo do mês');
  linha('Saldo no início do mês', relBRL(d.saldo_inicio_mes));
  linha('Receitas do mês', dem ? relBRL(dem.total_receitas) : 'não disponível');
  linha('Despesas do mês', dem ? relBRL(dem.total_despesas) : 'não disponível');
  if (dem && dem.total_receitas != null && dem.total_despesas != null) linha('Resultado do mês (receitas menos despesas)', relBRL(Math.round((dem.total_receitas - dem.total_despesas) * 100) / 100), { negrito: true });
  linha('Saldo no fim do mês', d.mes_fechado ? relBRL(d.saldo_fim_mes) : 'mês em andamento', { negrito: true });

  // 2. Saldo por conta (hoje)
  titulo('2. Saldo por conta hoje');
  if (!d.contas) nd(); else {
    d.contas.contas.forEach(function (c) { linha(c.descricao + (c.banco ? ' · ' + c.banco : '') + (c.principal ? ' (principal)' : ''), relBRL(c.saldo)); });
    linha('Total', relBRL(d.contas.total), { negrito: true });
  }

  // 3. Receitas e despesas
  titulo('3. Receitas do mês');
  if (!dem) nd(); else if (!dem.receitas.length) nd('Sem receitas lançadas no mês.'); else {
    dem.receitas.forEach(function (r) { linha(r.conta + ' ' + r.descricao, relBRL(r.valor)); });
    linha('Total de receitas', relBRL(dem.total_receitas), { negrito: true });
  }
  titulo('4. Despesas do mês');
  if (!dem) nd(); else if (!dem.despesas.length) nd('Sem despesas lançadas no mês.'); else {
    dem.despesas.forEach(function (g) {
      linha(g.conta + ' ' + g.descricao, relBRL(g.valor), { negrito: true });
      g.contas.forEach(function (c) { linha(c.conta + ' ' + c.descricao, relBRL(c.valor), { recuo: 5 }); });
    });
    linha('Total de despesas', relBRL(dem.total_despesas), { negrito: true });
  }

  // 5. Inadimplência
  titulo('5. Inadimplência hoje');
  if (!d.inadimplencia) nd(); else {
    linha('Unidades com débito', String(d.inadimplencia.quantidade_unidades));
    linha('Total original', relBRL(d.inadimplencia.total_original));
    linha('Total corrigido (juros e multa)', relBRL(d.inadimplencia.total_corrigido), { negrito: true });
    if (d.inadimplencia.maiores.length) {
      linha('Maiores débitos', null, { cinza: true });
      d.inadimplencia.maiores.forEach(function (u) { linha('Unidade ' + u.unidade + (u.bloco ? ' ' + u.bloco : '') + (u.dias_atraso_maior ? ' · ' + u.dias_atraso_maior + ' dias' : ''), relBRL(u.valor_corrigido), { recuo: 5 }); });
    }
    if (d.inadimplencia.truncado) linha('Lista parcial: o condomínio tem mais unidades em débito do que o limite da consulta.', null, { cinza: true });
  }

  // 6. Contas a pagar
  titulo('6. Contas a pagar nos próximos 30 dias');
  if (!d.a_vencer_30_dias) nd(); else if (!d.a_vencer_30_dias.itens.length) nd('Nenhuma conta a pagar lançada para os próximos 30 dias.'); else {
    d.a_vencer_30_dias.itens.forEach(function (c) { linha(c.vencimento + ' · ' + (c.fornecedor || 'fornecedor') + (c.descricao ? ' · ' + c.descricao : ''), relBRL(c.valor)); });
    linha('Total', relBRL(d.a_vencer_30_dias.total), { negrito: true });
    if (d.a_vencer_30_dias.truncado) linha('Lista parcial: há mais contas do que o limite da consulta; o total acima é parcial.', null, { cinza: true });
  }
  if (!d.vencidas) linha('Contas vencidas e não pagas: não disponível.', null, { cinza: true });
  else if (d.vencidas.quantidade) linha('Contas vencidas e não pagas (últimos 12 meses): ' + d.vencidas.quantidade + (d.vencidas.truncado ? ' (lista parcial)' : ''), relBRL(d.vencidas.total), { negrito: true });

  // 7. Alertas
  titulo('7. Alertas em aberto');
  if (!d.alertas) nd(); else {
    if (d.alertas_parciais) linha('Lista incompleta: não foi possível ler ' + d.alertas_parciais.join(', ') + '.', null, { cinza: true });
    if (!d.alertas.length) nd(d.alertas_parciais ? 'Nenhum alerta nas partes que foram lidas.' : 'Nenhum alerta em aberto.');
    else d.alertas.forEach(function (a) { linha(a.titulo); });
  }

  // Rodapé com página
  var n = doc.getNumberOfPages();
  for (var i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor.apply(doc, CINZA);
    doc.text('Gerado pelo Service Hub em ' + new Date().toLocaleString('pt-BR') + ' com dados do Superlógica', ML, ALT - 8);
    doc.text('Página ' + i + ' de ' + n, ML + LARG, ALT - 8, { align: 'right' });
  }
  return doc;
}

document.addEventListener('auth:ready', relPreencherMeses);
setTimeout(relPreencherMeses, 0);
