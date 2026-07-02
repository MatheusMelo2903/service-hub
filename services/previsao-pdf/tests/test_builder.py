from app.adapter import adaptar
from app.builder_pptx import Builder, calcular_taxas

from .test_adapter import _payload_mock, _config_mock


def test_builder_constroi_presentation():
    dados = adaptar(_payload_mock(), _config_mock())
    taxas = calcular_taxas(dados)
    builder = Builder(dados, taxas, logo_path=None)
    prs = builder.build()
    assert prs is not None
    assert len(prs.slides) >= 5  # capa + metodologia + panorama + >=1 detalhamento + encerramento
