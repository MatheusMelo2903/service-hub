"""Teste do converter via mock - evita dependencia de libreoffice no CI."""
from unittest.mock import patch, MagicMock

import pytest


@patch('app.converter.subprocess.run')
def test_converter_chama_libreoffice(mock_run, tmp_path):
    from app.converter import converter_para_pdf
    pptx = tmp_path / 'foo.pptx'
    pptx.write_bytes(b'fake pptx')
    pdf = tmp_path / 'foo.pdf'
    pdf.write_bytes(b'%PDF-1.4 fake')
    mock_run.return_value = MagicMock(returncode=0, stderr=b'')
    result = converter_para_pdf(str(pptx), outdir=str(tmp_path))
    assert result == str(pdf)
    mock_run.assert_called_once()


@patch('app.converter.subprocess.run')
def test_converter_levanta_se_exit_nao_zero(mock_run, tmp_path):
    from app.converter import converter_para_pdf
    pptx = tmp_path / 'foo.pptx'
    pptx.write_bytes(b'fake')
    mock_run.return_value = MagicMock(returncode=1, stderr=b'erro')
    with pytest.raises(RuntimeError, match='libreoffice_falhou'):
        converter_para_pdf(str(pptx), outdir=str(tmp_path))
