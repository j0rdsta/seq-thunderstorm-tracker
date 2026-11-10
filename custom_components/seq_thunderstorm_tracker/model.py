"""The snapshot the bridge userscript posts, and what it means for one place.

No Home Assistant imports: this is plain data and arithmetic.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import math
import re
from typing import Any

from . import geo

SNAPSHOT_VERSION = 1
MAX_CELLS = 400
MAX_FORECAST_POINTS = 12000
MAX_DESCRIPTION = 4000
MAX_IMAGE_BYTES = 1024 * 1024
MAX_FUTURE = timedelta(minutes=10)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# A little beyond the tracker image on every side.
LAT_RANGE = (-31.0, -24.5)
LON_RANGE = (150.0, 156.0)


class SnapshotError(ValueError):
    """The payload is not a snapshot this integration can use."""


@dataclass(frozen=True, slots=True)
class Cell:
    """One tracked storm, as the Bureau drew it."""

    lat: float
    lon: float
    area_km2: float
    major_km: float  # semi-axes of the drawn ellipse
    minor_km: float
    bearing: float  # compass bearing of the major axis, 0 to 180


@dataclass(frozen=True, slots=True)
class Snapshot:
    """What the tracker showed at one moment."""

    issued: datetime
    hash: str
    cells: tuple[Cell, ...]
    forecast: tuple[tuple[float, float], ...]  # (lon, lat) along arrows and arcs
    description: str | None
    source: str
    image_png: bytes | None


@dataclass(frozen=True, slots=True)
class Proximity:
    """The tracker's storms as seen from one place."""

    in_coverage: bool
    storms: int
    distance_km: float | None = None
    bearing: float | None = None
    direction: str | None = None
    storm_lat: float | None = None
    storm_lon: float | None = None
    forecast_km: float | None = None
    forecast_bearing: float | None = None
    forecast_direction: str | None = None
    storms_within_radius: int = 0


def _number(value: Any, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SnapshotError(f"{name} must be a number")
    if not low <= value <= high:
        raise SnapshotError(f"{name} is out of range")
    return float(value)


def parse_snapshot(payload: Any, *, now: datetime | None = None) -> Snapshot:
    """Validate a webhook payload. Raises SnapshotError with a reason that is safe to return."""
    if not isinstance(payload, dict):
        raise SnapshotError("the body must be a JSON object")
    if payload.get("v") != SNAPSHOT_VERSION:
        raise SnapshotError("unsupported snapshot version")

    now = now or datetime.now(UTC)
    issued_ms = _number(payload.get("issued"), "issued", 1e12, 1e14)
    issued = datetime.fromtimestamp(issued_ms / 1000, UTC)
    if issued - now > MAX_FUTURE:
        raise SnapshotError("issued is in the future")

    storm_hash = payload.get("hash")
    if not isinstance(storm_hash, str) or not re.fullmatch(r"[0-9a-f]{1,16}", storm_hash):
        raise SnapshotError("hash must be a short hex string")

    raw_cells = payload.get("cells")
    if not isinstance(raw_cells, list) or len(raw_cells) > MAX_CELLS:
        raise SnapshotError("cells must be a list")
    cells = []
    for raw in raw_cells:
        if not isinstance(raw, dict):
            raise SnapshotError("each cell must be an object")
        cells.append(
            Cell(
                lat=_number(raw.get("lat"), "cell lat", *LAT_RANGE),
                lon=_number(raw.get("lon"), "cell lon", *LON_RANGE),
                area_km2=_number(raw.get("area_km2"), "cell area_km2", 0, 1e5),
                major_km=_number(raw.get("major_km"), "cell major_km", 0, 500),
                minor_km=_number(raw.get("minor_km"), "cell minor_km", 0, 500),
                bearing=_number(raw.get("bearing"), "cell bearing", 0, 180),
            )
        )

    raw_forecast = payload.get("forecast", [])
    if not isinstance(raw_forecast, list) or len(raw_forecast) > MAX_FORECAST_POINTS:
        raise SnapshotError("forecast must be a list")
    forecast = []
    for point in raw_forecast:
        if not isinstance(point, list) or len(point) != 2:
            raise SnapshotError("each forecast point must be [lon, lat]")
        forecast.append(
            (
                _number(point[0], "forecast lon", *LON_RANGE),
                _number(point[1], "forecast lat", *LAT_RANGE),
            )
        )

    description = payload.get("description")
    if description is not None:
        if not isinstance(description, str):
            raise SnapshotError("description must be text")
        description = " ".join(description.split())[:MAX_DESCRIPTION] or None

    source = payload.get("source")
    source = source[:80] if isinstance(source, str) else "unknown"

    image_png = None
    image = payload.get("image")
    if image is not None:
        if not isinstance(image, dict) or not isinstance(image.get("png"), str):
            raise SnapshotError("image must be an object with a png")
        if (image.get("w"), image.get("h")) != (geo.IMAGE_W, geo.IMAGE_H):
            raise SnapshotError("the image is not the size the tracker is known to use")
        if len(image["png"]) > MAX_IMAGE_BYTES * 4 // 3 + 4:
            raise SnapshotError("the image is too large")
        try:
            image_png = base64.b64decode(image["png"], validate=True)
        except (binascii.Error, ValueError) as err:
            raise SnapshotError("the image is not valid base64") from err
        if not image_png.startswith(PNG_MAGIC):
            raise SnapshotError("the image is not a PNG")

    return Snapshot(
        issued=issued,
        hash=storm_hash,
        cells=tuple(cells),
        forecast=tuple(forecast),
        description=description,
        source=source,
        image_png=image_png,
    )


def cell_edge_distance_km(cell: Cell, lat: float, lon: float) -> float:
    """Distance from a place to the edge of a storm's ellipse (0 when inside it)."""
    to_centre = geo.haversine_km(lat, lon, cell.lat, cell.lon)
    outward = geo.bearing_deg(cell.lat, cell.lon, lat, lon)
    reach = geo.ellipse_radius_km(cell.major_km, cell.minor_km, cell.bearing, outward)
    return max(0.0, to_centre - reach)


def proximity(snapshot: Snapshot, lat: float, lon: float, radius_km: float) -> Proximity:
    """Measure the snapshot's storms from one place."""
    storms = len(snapshot.cells)
    if not geo.in_coverage(lat, lon):
        return Proximity(in_coverage=False, storms=storms)

    nearest: tuple[float, Cell] | None = None
    within = 0
    for cell in snapshot.cells:
        distance = cell_edge_distance_km(cell, lat, lon)
        if distance <= radius_km:
            within += 1
        if nearest is None or distance < nearest[0]:
            nearest = (distance, cell)

    track: tuple[float, float, float] | None = None
    for p_lon, p_lat in snapshot.forecast:
        distance = geo.haversine_km(lat, lon, p_lat, p_lon)
        if track is None or distance < track[0]:
            track = (distance, p_lat, p_lon)
    # The forecast track starts at the storm, so it is never further away than the storm is.
    if nearest is not None and (track is None or nearest[0] < track[0]):
        track = (nearest[0], nearest[1].lat, nearest[1].lon)

    result: dict[str, Any] = {"in_coverage": True, "storms": storms, "storms_within_radius": within}
    if nearest is not None:
        bearing = geo.bearing_deg(lat, lon, nearest[1].lat, nearest[1].lon)
        result.update(
            distance_km=nearest[0],
            bearing=bearing,
            direction=geo.compass(bearing),
            storm_lat=nearest[1].lat,
            storm_lon=nearest[1].lon,
        )
    if track is not None:
        bearing = geo.bearing_deg(lat, lon, track[1], track[2])
        result.update(
            forecast_km=track[0],
            forecast_bearing=bearing,
            forecast_direction=geo.compass(bearing),
        )
    return Proximity(**result)
