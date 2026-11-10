"""Shared fixtures. The Home Assistant test harness comes from pytest-homeassistant-custom-component."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent.parent / "fixtures"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Let Home Assistant load the integration from custom_components/."""
    return


@pytest.fixture(scope="session")
def georef() -> dict:
    return json.loads((FIXTURES / "georef.json").read_text())
