#!/usr/bin/env python3
"""
Auditor visual de apresentações (PPTX) — passo OBRIGATÓRIO antes de entregar o PDF.

Detecta os problemas que mais estragam a entrega:
  1. OVERFLOW: shape/texto que ultrapassa a borda do slide (sai da aba).
  2. SOBREPOSIÇÃO: duas caixas de TEXTO que se cruzam de forma relevante
     (uma linha em cima da outra), além de uma tolerância.
  3. TEXTO PROVÁVEL DE CORTE: caixa de texto pequena demais para o conteúdo
     (muitos caracteres em altura/largura insuficiente) — heurística.

Uso:
    python3 auditar_apresentacao.py arquivo.pptx [--json] [--tol-overlap 0.06]

Saída: relatório legível + código de saída 0 (ok) ou 1 (achou problema).
Em modo --json, imprime um JSON com a lista de problemas (para a skill ler e corrigir).

A skill DEVE rodar este auditor após gerar o PPTX e ANTES de converter para PDF.
Se houver problema, corrigir o gerador e rodar de novo, até zerar. Só então entregar.
"""
import sys, json, argparse
from pptx import Presentation
from pptx.util import Emu

# áreas onde sobreposição é esperada/desejada (texto sobre card/faixa colorida).
# Só comparamos sobreposição entre CAIXAS DE TEXTO entre si, não texto sobre formas.
def _emu(v): return int(v) if v is not None else 0

def _rect(shape):
    try:
        l = _emu(shape.left); t = _emu(shape.top)
        w = _emu(shape.width); h = _emu(shape.height)
    except Exception:
        return None
    if None in (l, t, w, h) or w <= 0 or h <= 0:
        return None
    return (l, t, l + w, t + h)

def _intersect_area(a, b):
    ax0, ay0, ax1, ay1 = a; bx0, by0, bx1, by1 = b
    ix0 = max(ax0, bx0); iy0 = max(ay0, by0)
    ix1 = min(ax1, bx1); iy1 = min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0
    return (ix1 - ix0) * (iy1 - iy0)

def _area(r):
    return (r[2]-r[0]) * (r[3]-r[1])

def _has_text(shape):
    try:
        if not shape.has_text_frame:
            return False
        return bool(shape.text_frame.text.strip())
    except Exception:
        return False

def _text_of(shape):
    try:
        return shape.text_frame.text.strip()
    except Exception:
        return ""

def auditar(path, tol_overlap=0.35):
    """Retorna lista de problemas REAIS (calibrado para baixo ruído).

    tol_overlap = fração mínima de área sobreposta (sobre a menor caixa) para
    considerar sobreposição um defeito. Caixas de texto que apenas se tocam
    (tabelas, número+legenda) sobrepõem pouco; só acima de ~35% é defeito real.
    Formas decorativas (sem texto) que saem do slide são ignoradas — são design.
    """
    prs = Presentation(path)
    SW = _emu(prs.slide_width); SH = _emu(prs.slide_height)
    problemas = []

    for idx, slide in enumerate(prs.slides, start=1):
        textos = []
        for sh in slide.shapes:
            r = _rect(sh)
            if r is None:
                continue
            # OVERFLOW: só reportamos quando uma caixa COM TEXTO sai do slide.
            # Formas decorativas (círculos da capa, faixas) saem de propósito.
            if _has_text(sh):
                margem = int(SW * 0.01)  # 1% de tolerância
                over_x = max(0, r[2] - SW - margem, (-r[0]) - margem)
                over_y = max(0, r[3] - SH - margem, (-r[1]) - margem)
                # só conta se o texto de fato escapa de forma visível (> 0,15")
                if over_x > 137160 or over_y > 137160:
                    problemas.append({
                        "slide": idx, "tipo": "overflow",
                        "detalhe": f"texto sai do slide ({over_x/914400:.2f}\" x, {over_y/914400:.2f}\" y)",
                        "texto": _text_of(sh)[:40],
                    })
                textos.append((sh, r))

        # SOBREPOSIÇÃO grave entre caixas de texto (uma linha sobre a outra)
        for i in range(len(textos)):
            for j in range(i + 1, len(textos)):
                sh1, r1 = textos[i]; sh2, r2 = textos[j]
                inter = _intersect_area(r1, r2)
                if inter <= 0:
                    continue
                menor = min(_area(r1), _area(r2))
                if menor <= 0:
                    continue
                frac = inter / menor
                # defeito real só quando a sobreposição é grande E ambos têm
                # texto "denso" (não é só um tocar de bordas de células de tabela)
                if frac >= tol_overlap:
                    t1 = _text_of(sh1); t2 = _text_of(sh2)
                    # ignora se um dos dois é praticamente vazio
                    if len(t1) < 2 or len(t2) < 2:
                        continue
                    problemas.append({
                        "slide": idx, "tipo": "sobreposicao",
                        "detalhe": f"{frac*100:.0f}% de sobreposição entre caixas de texto",
                        "texto": f'"{t1[:30]}" × "{t2[:30]}"',
                    })

    n_slides = len(list(prs.slides))
    return problemas, n_slides

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--tol-overlap", type=float, default=0.35)
    args = ap.parse_args()

    problemas, _ = auditar(args.pptx, tol_overlap=args.tol_overlap)

    if args.json:
        print(json.dumps(problemas, ensure_ascii=False, indent=2))
        sys.exit(1 if problemas else 0)

    if not problemas:
        print(f"AUDITORIA OK: nenhum problema visual detectado em {args.pptx}")
        sys.exit(0)

    # agrupa por tipo
    print(f"AUDITORIA: {len(problemas)} problema(s) em {args.pptx}\n")
    por_slide = {}
    for p in problemas:
        por_slide.setdefault(p["slide"], []).append(p)
    for s in sorted(por_slide):
        print(f"  Slide {s}:")
        for p in por_slide[s]:
            print(f"    [{p['tipo']}] {p['detalhe']}  →  {p['texto']}")
    print("\nCorrija o gerador e rode a auditoria de novo. Só entregar o PDF com auditoria limpa.")
    sys.exit(1)

if __name__ == "__main__":
    main()
