from __future__ import annotations
from pydantic import BaseModel, Field


class ConfigRateio(BaseModel):
    apartamentos: int = Field(ge=1, description='Numero de apartamentos. Obrigatorio, minimo 1.')
    coberturas: int = Field(default=0, ge=0)
    fator_cobertura: float = Field(default=1.5, gt=0)
    fundo_reserva: float = Field(default=0.0, ge=0)
    fundo_pct: float = Field(default=0.05, ge=0, le=1)


class GerarRequest(BaseModel):
    previsao_id: str
    payload_json: dict
    payload_hash: str
    config_rateio: ConfigRateio


class GerarResponse(BaseModel):
    pptx_b64: str
    pdf_b64: str
    duracao_ms: int
