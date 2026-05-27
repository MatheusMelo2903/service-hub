-- Seed mockup de dev — 5 condomínios + demandas + laudos + histórico
-- Idempotente: limpa dados marcados como mockup antes de inserir
-- Roda contra o Supabase DEV (ledgyprytkuvgtbunsck). NUNCA em prod.

BEGIN;

-- 1) Limpeza seletiva (apenas mockup=true) — preserva qualquer dado real
DELETE FROM public.demandas   WHERE mockup = true;
DELETE FROM public.laudos     WHERE mockup = true;
DELETE FROM public.historico  WHERE mockup = true;
DELETE FROM public.condominios WHERE mockup = true;

-- 2) Condomínios (UUIDs fixos pra facilitar referência cruzada e re-run idempotente)
INSERT INTO public.condominios (id, nome, endereco, cnpj, unidades_total, inadimplencia_valor, inadimplencia_qtd, proposito_teste, mockup) VALUES
  ('11111111-1111-1111-1111-111111111001', 'Condomínio Buritis',
   'Rua dos Buritis, 500 — Jardim da Penha, Vitória/ES — 29060-200',
   '12.345.678/0001-01',
   54, 127818.80, 18,
   'Inadimplência alta — testa Fase 1.4 (painel inadimplência + IA Buritis R$127k)',
   true),
  ('11111111-1111-1111-1111-111111111002', 'Condomínio Praia Dourada',
   'Av. Beira Mar, 1234 — Praia do Canto, Vitória/ES — 29055-035',
   '12.345.678/0001-02',
   32, 0, 0,
   'Adimplente + assembleia recente — testa geração de ata e edital (Feature 1+2)',
   true),
  ('11111111-1111-1111-1111-111111111003', 'Condomínio Solar das Palmeiras',
   'Rua das Palmeiras, 78 — Praia da Costa, Vila Velha/ES — 29101-450',
   '12.345.678/0001-03',
   18, 4250.00, 2,
   '3 demandas abertas (elétrica, hidráulica, mecânica) — testa módulo de demandas',
   true),
  ('11111111-1111-1111-1111-111111111004', 'Condomínio Vila Nova',
   'Rua Vila Nova, 321 — Itararé, Vila Velha/ES — 29115-280',
   '12.345.678/0001-04',
   24, 1820.00, 1,
   'Medidores com leituras pendentes — testa Leitura de Consumo (Feature OCR)',
   true),
  ('11111111-1111-1111-1111-111111111005', 'Condomínio Residencial Vitória',
   'Av. Nossa Senhora da Penha, 890 — Praia do Suá, Vitória/ES — 29055-130',
   '12.345.678/0001-05',
   40, 8970.50, 4,
   'Conciliação bancária pendente — testa Fase 1.5 (conciliação automática)',
   true);

-- 3) Demandas — todas em Solar das Palmeiras (id 003)
INSERT INTO public.demandas (condominio_id, titulo, categoria, prioridade, status, origem_texto_bruto, fonte, mockup) VALUES
  ('11111111-1111-1111-1111-111111111003',
   'Curto-circuito no corredor do 3º andar',
   'eletrica', 'alta', 'aberta',
   'Síndico Marcos relata: às 18h de ontem disjuntores do 3º andar caíram. Sem energia nas áreas comuns desse pavimento. Solicita eletricista urgente.',
   'whatsapp_sindico', true),
  ('11111111-1111-1111-1111-111111111003',
   'Vazamento na caixa d''água superior',
   'hidraulica', 'urgente', 'em_andamento',
   'Goteira constante saindo da tampa da caixa d''água. Síndica Patrícia já chamou hidráulico — chega amanhã 8h.',
   'email_administradora', true),
  ('11111111-1111-1111-1111-111111111003',
   'Portão da garagem travando ao fechar',
   'mecanica', 'media', 'aberta',
   'Portão fecha apenas até a metade, depois trava. Já travou 3 vezes esta semana. Motor parece estar funcionando, possível problema na corrente.',
   'app_morador', true);

-- 4) Laudos — leituras de medidores em Praia Dourada (id 002)
INSERT INTO public.laudos (condominio_id, unidade, tipo, consumo_m3, data_leitura, mockup) VALUES
  ('11111111-1111-1111-1111-111111111002', '101-A', 'agua', 47.0, CURRENT_DATE - INTERVAL '2 days', true),
  ('11111111-1111-1111-1111-111111111002', '102-B', 'agua', 31.0, CURRENT_DATE - INTERVAL '2 days', true),
  ('11111111-1111-1111-1111-111111111002', '201-A', 'agua', 58.0, CURRENT_DATE - INTERVAL '2 days', true),
  -- Vila Nova com leituras pendentes (sem consumo registrado ainda, mas com unidades cadastradas)
  ('11111111-1111-1111-1111-111111111004', '101', 'agua', NULL, NULL, true),
  ('11111111-1111-1111-1111-111111111004', '102', 'agua', NULL, NULL, true),
  ('11111111-1111-1111-1111-111111111004', '201', 'gas',  NULL, NULL, true);

-- 5) Histórico — eventos plausíveis por condomínio
INSERT INTO public.historico (condominio_id, evento, descricao, mockup) VALUES
  ('11111111-1111-1111-1111-111111111001', 'importacao_unidades',
   'Importadas 54 unidades do Superlógica em 18/05/2026', true),
  ('11111111-1111-1111-1111-111111111001', 'inadimplencia_alerta',
   'Painel detectou pico de inadimplência: 18 unidades em atraso totalizando R$ 127.818,80', true),
  ('11111111-1111-1111-1111-111111111002', 'ata_gerada',
   'Ata da AGO 20/05/2026 gerada via IA e baixada como PDF', true),
  ('11111111-1111-1111-1111-111111111002', 'edital_processado',
   'Edital de convocação processado: 7 itens de pauta extraídos', true),
  ('11111111-1111-1111-1111-111111111003', 'demanda_aberta',
   'Demanda crítica aberta: vazamento caixa d''água (prioridade urgente)', true),
  ('11111111-1111-1111-1111-111111111005', 'conciliacao_pendente',
   'Extrato bancário de 25/05/2026 aguarda conciliação (12 lançamentos)', true);

COMMIT;

-- Sumário pós-seed
SELECT 'condominios mockup' AS tabela, COUNT(*) AS total FROM public.condominios WHERE mockup = true
UNION ALL SELECT 'demandas mockup',  COUNT(*) FROM public.demandas WHERE mockup = true
UNION ALL SELECT 'laudos mockup',    COUNT(*) FROM public.laudos WHERE mockup = true
UNION ALL SELECT 'historico mockup', COUNT(*) FROM public.historico WHERE mockup = true;
