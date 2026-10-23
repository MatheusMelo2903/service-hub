// Monta o acervo de regras do condomínio de teste copiando os documentos de um condomínio real:
// convenção e regimento que valem hoje e as atas mais recentes, com os trechos (artigos) já
// separados e o PDF de cada documento. Serve para simular notificação, multa e consulta no teste
// sem gravar nada em condomínio real do Superlógica.
// Uso (no Mac, com o Railway ligado ao projeto):
//   railway run -e dev -s <service-hub> node scripts/acervo-teste-167.js <origem> [destino=167] [atas=6]
// As chaves vêm do ambiente (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY); nada é impresso.
// Só roda se o destino ainda não tiver nenhum documento no acervo (nunca apaga nem duplica).
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const origem = Number(process.argv[2]);
const destino = Number(process.argv[3] || 167);
const qtdAtas = Number(process.argv[4] || 6);
if (!Number.isInteger(origem) || origem <= 0 || !Number.isInteger(destino) || destino <= 0 || origem === destino) {
  console.error('uso: node scripts/acervo-teste-167.js <origem> [destino=167] [atas=6]'); process.exit(1);
}
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const BUCKET = 'regras';

async function rest(metodo, caminho, corpo, extra) {
  const r = await fetch(URL + '/rest/v1/' + caminho, {
    method: metodo, headers: { ...H, 'Content-Type': 'application/json', ...(extra || {}) }, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!r.ok) throw new Error(metodo + ' ' + caminho.split('?')[0] + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.status === 204 ? null : r.json();
}
const ler = (caminho) => rest('GET', caminho);

// Copia o PDF dentro do mesmo bucket, sem baixar para a máquina.
async function copiarArquivo(de, para) {
  const r = await fetch(URL + '/storage/v1/object/copy', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ bucketId: BUCKET, sourceKey: de, destinationKey: para }),
  });
  if (!r.ok) throw new Error('copiar arquivo ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

(async () => {
  const ja = await ler('regras_documentos?select=id&id_superlogica=eq.' + destino + '&limit=1');
  if (ja.length) { console.error('o condomínio ' + destino + ' já tem acervo; nada foi feito'); process.exit(2); }

  const base = await ler('regras_documentos?select=*&id_superlogica=eq.' + origem + '&tipo=in.(convencao,regimento)&vigente=is.true&order=data_documento.desc.nullslast');
  const atas = await ler('regras_documentos?select=*&id_superlogica=eq.' + origem + '&tipo=eq.ata&order=data_documento.desc.nullslast&limit=' + qtdAtas);
  const docs = base.concat(atas);
  if (!base.some((d) => d.tipo === 'convencao') || !base.some((d) => d.tipo === 'regimento')) {
    console.error('a origem não tem convenção e regimento vigentes'); process.exit(3);
  }

  const novoId = new Map();
  let arquivos = 0, trechos = 0;
  for (const d of docs) {
    const linha = { ...d };
    delete linha.id; delete linha.criado_em; delete linha.atualizado_em;
    linha.id_superlogica = destino;
    linha.criado_por = null;
    linha.condgpt_slug = null;
    linha.cnpj = null;
    linha.arquivo_path = null;
    linha.observacao = 'Cópia de teste (acervo do condomínio ' + origem + ').';
    const [novo] = await rest('POST', 'regras_documentos', [linha], { Prefer: 'return=representation' });
    novoId.set(d.id, novo.id);
    if (d.arquivo_path) {
      const caminho = destino + '/' + novo.id + '.pdf';
      await copiarArquivo(d.arquivo_path, caminho);
      await rest('PATCH', 'regras_documentos?id=eq.' + novo.id, { arquivo_path: caminho });
      arquivos++;
    }
    // Trechos (artigos) do documento, religados ao id novo. tsv é calculado pelo banco.
    const t = await ler('regras_trechos?select=ordem,rotulo,titulo,texto,pagina&documento_id=eq.' + d.id + '&order=ordem');
    for (let i = 0; i < t.length; i += 200) {
      await rest('POST', 'regras_trechos', t.slice(i, i + 200).map((x) => ({ ...x, documento_id: novo.id, id_superlogica: destino })), { Prefer: 'return=minimal' });
    }
    trechos += t.length;
  }

  const mand = await ler('regras_mandatos?select=cargo,nome,inicio,fim,documento_id,trecho,conferido&id_superlogica=eq.' + origem);
  if (mand.length) {
    await rest('POST', 'regras_mandatos', mand.map((m) => ({ ...m, id_superlogica: destino, documento_id: m.documento_id ? (novoId.get(m.documento_id) || null) : null })), { Prefer: 'return=minimal' });
  }
  console.log('documentos: ' + docs.length + ' (' + base.length + ' convenção e regimento, ' + atas.length + ' atas), arquivos: ' + arquivos + ', trechos: ' + trechos + ', mandatos: ' + mand.length);
})().catch((e) => { console.error('falhou: ' + e.message); process.exit(1); });
