"""Builders shared by the tests: tracker-shaped images and bridge payloads."""

from __future__ import annotations

import base64
from io import BytesIO

from PIL import Image, ImageDraw

BASEMAP = (229, 222, 201)
FILL = (245, 189, 138)

# Brisbane CBD.
BRISBANE = (-27.4698, 153.0251)


def tracker_png(size: tuple[int, int] = (600, 643), blobs: tuple[tuple[int, int, int, int], ...] = ()) -> bytes:
    """A tracker-shaped PNG with filled ellipses (cx, cy, rx, ry) in the storm colour."""
    img = Image.new("RGB", size, BASEMAP)
    draw = ImageDraw.Draw(img)
    for cx, cy, rx, ry in blobs:
        draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=FILL)
    buffer = BytesIO()
    img.save(buffer, "PNG")
    return buffer.getvalue()


def make_payload(
    issued_ms: int,
    *,
    cells: list[dict] | None = None,
    forecast: list[list[float]] | None = None,
    image: bytes | None = None,
    storm_hash: str = "ab12cd34",
    description: str | None = "At 3:40 pm, thunderstorms were detected near Ipswich.",
) -> dict:
    """A snapshot as the bridge userscript posts it."""
    return {
        "v": 1,
        "source": "test/1",
        "issued": issued_ms,
        "hash": storm_hash,
        "image": None
        if image is None
        else {"w": 600, "h": 643, "png": base64.b64encode(image).decode()},
        "cells": cells if cells is not None else [],
        "forecast": forecast if forecast is not None else [],
        "description": description,
    }


def cell(lat: float, lon: float, major: float = 6.0, minor: float = 4.0, bearing: float = 90.0) -> dict:
    return {
        "lat": lat,
        "lon": lon,
        "area_km2": round(3.14159 * major * minor, 1),
        "major_km": major,
        "minor_km": minor,
        "bearing": bearing,
    }
