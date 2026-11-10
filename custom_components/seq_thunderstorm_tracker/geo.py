"""Where the tracker image sits on the Earth, and distances across it.

The georeference mirrors ``packages/core/georef.js``. ``test/fixtures/georef.json`` is checked
by both the JavaScript and the Python tests, so the two cannot drift apart unnoticed.
This module has no Home Assistant imports.
"""

from __future__ import annotations

import math

IMAGE_W = 600
IMAGE_H = 643

# Web Mercator (EPSG:3857) metres of three corners of IDA00050.png.
CORNER_TL = (16852901.89, -3018857.35)  # pixel (0, 0)
CORNER_TR = (17134364.43, -3020336.98)  # pixel (IMAGE_W, 0)
CORNER_BL = (16852265.34, -3301850.42)  # pixel (0, IMAGE_H)

MERCATOR_RADIUS_M = 6378137.0
EARTH_RADIUS_KM = 6371.0088

# Image pixel -> Mercator: X = A*px + C*py + E, Y = B*px + D*py + F
A = (CORNER_TR[0] - CORNER_TL[0]) / IMAGE_W
B = (CORNER_TR[1] - CORNER_TL[1]) / IMAGE_W
C = (CORNER_BL[0] - CORNER_TL[0]) / IMAGE_H
D = (CORNER_BL[1] - CORNER_TL[1]) / IMAGE_H
E, F = CORNER_TL
_DET = A * D - B * C

COMPASS_POINTS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


def lonlat_to_mercator(lon: float, lat: float) -> tuple[float, float]:
    """Project degrees to Web Mercator metres."""
    return (
        math.radians(lon) * MERCATOR_RADIUS_M,
        math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * MERCATOR_RADIUS_M,
    )


def mercator_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """Web Mercator metres back to degrees."""
    return (
        math.degrees(x / MERCATOR_RADIUS_M),
        math.degrees(2 * math.atan(math.exp(y / MERCATOR_RADIUS_M)) - math.pi / 2),
    )


def pixel_to_lonlat(px: float, py: float) -> tuple[float, float]:
    """Where an image pixel is on the ground."""
    return mercator_to_lonlat(A * px + C * py + E, B * px + D * py + F)


def lonlat_to_pixel(lon: float, lat: float) -> tuple[float, float]:
    """Where a place falls on the tracker image (may be outside it)."""
    x, y = lonlat_to_mercator(lon, lat)
    dx, dy = x - E, y - F
    return ((D * dx - C * dy) / _DET, (A * dy - B * dx) / _DET)


def in_coverage(lat: float, lon: float) -> bool:
    """Whether a place is inside the tracker image."""
    px, py = lonlat_to_pixel(lon, lat)
    return 0 <= px <= IMAGE_W and 0 <= py <= IMAGE_H


def km_per_pixel(lat: float) -> tuple[float, float]:
    """Ground size of one image pixel (across, down) at a latitude.

    The pixels are not square on the ground: about 0.42 km by 0.39 km near Brisbane.
    """
    k = math.cos(math.radians(lat)) / 1000
    return (math.hypot(A, B) * k, math.hypot(C, D) * k)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compass bearing from the first place to the second, 0 to 360."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360


def compass(bearing: float) -> str:
    """Eight-point compass name for a bearing."""
    return COMPASS_POINTS[round((bearing % 360) / 45) % 8]


def ellipse_radius_km(major_km: float, minor_km: float, axis_bearing: float, toward: float) -> float:
    """How far an ellipse reaches from its centre in a compass direction.

    ``axis_bearing`` is the bearing of the major axis, ``toward`` the direction of interest.
    """
    if major_km <= 0 or minor_km <= 0:
        return max(major_km, minor_km, 0.0)
    phi = math.radians(toward - axis_bearing)
    return (major_km * minor_km) / math.hypot(minor_km * math.cos(phi), major_km * math.sin(phi))
