"""Geometry, snapshot validation and map drawing. No Home Assistant needed."""

from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO
import math

from PIL import Image
import pytest

from custom_components.seq_thunderstorm_tracker import geo
from custom_components.seq_thunderstorm_tracker.model import (
    Cell,
    Snapshot,
    SnapshotError,
    cell_edge_distance_km,
    parse_snapshot,
    proximity,
)
from custom_components.seq_thunderstorm_tracker.render import ImageError, check_tracker_png, render_map

from helpers import BRISBANE, cell, make_payload, tracker_png

NOW = datetime(2026, 11, 10, 5, 45, tzinfo=UTC)
ISSUED_MS = int(datetime(2026, 11, 10, 5, 42, tzinfo=UTC).timestamp() * 1000)


def snapshot(cells=(), forecast=()) -> Snapshot:
    return Snapshot(
        issued=NOW, hash="ab", cells=tuple(cells), forecast=tuple(forecast), description=None, source="t", image_png=None
    )


# ----- geo ---------------------------------------------------------------------


def test_georeference_matches_the_javascript_core(georef):
    assert (geo.IMAGE_W, geo.IMAGE_H) == (georef["image"]["w"], georef["image"]["h"])
    assert list(geo.CORNER_TL) == georef["corners"]["tl"]
    assert list(geo.CORNER_TR) == georef["corners"]["tr"]
    assert list(geo.CORNER_BL) == georef["corners"]["bl"]
    for sample in georef["pixel_to_lonlat"]:
        lon, lat = geo.pixel_to_lonlat(*sample["px"])
        assert lon == pytest.approx(sample["lonlat"][0], abs=1e-9)
        assert lat == pytest.approx(sample["lonlat"][1], abs=1e-9)
        px, py = geo.lonlat_to_pixel(lon, lat)
        assert (px, py) == pytest.approx(tuple(sample["px"]), abs=1e-6)
    scale = georef["km_per_pixel_at_brisbane"]
    assert geo.km_per_pixel(scale["lat"]) == pytest.approx((scale["across"], scale["down"]), rel=1e-12)


def test_coverage_is_southeast_queensland():
    assert geo.in_coverage(*BRISBANE)
    assert geo.in_coverage(-27.56, 151.95)  # Toowoomba
    assert not geo.in_coverage(-33.87, 151.21)  # Sydney
    assert not geo.in_coverage(-27.47, 156.5)  # out to sea


def test_distance_bearing_and_compass():
    # Brisbane to Ipswich: about 30 km to the south-west.
    d = geo.haversine_km(*BRISBANE, -27.6141, 152.76)
    assert d == pytest.approx(30.6, abs=0.5)
    assert geo.compass(geo.bearing_deg(*BRISBANE, -27.6141, 152.76)) == "SW"
    assert geo.compass(geo.bearing_deg(*BRISBANE, -26.66, 153.099)) == "N"
    assert [geo.compass(b) for b in (0, 44, 46, 180, 337, 338, 359.9)] == ["N", "NE", "NE", "S", "NW", "N", "N"]


def test_ellipse_radius_follows_its_axes():
    assert geo.ellipse_radius_km(10, 4, 90, 90) == pytest.approx(10)
    assert geo.ellipse_radius_km(10, 4, 90, 270) == pytest.approx(10)
    assert geo.ellipse_radius_km(10, 4, 90, 0) == pytest.approx(4)
    assert 4 < geo.ellipse_radius_km(10, 4, 90, 45) < 10
    assert geo.ellipse_radius_km(0, 0, 0, 10) == 0


# ----- proximity ----------------------------------------------------------------


def test_distance_is_to_the_storm_edge_not_its_centre():
    lat, lon = BRISBANE
    # A storm centred 0.3° west (about 29.6 km), 10 km long east-west and 4 km north-south.
    storm = Cell(lat=lat, lon=lon - 0.3, area_km2=125, major_km=10, minor_km=4, bearing=90)
    centre = geo.haversine_km(lat, lon, storm.lat, storm.lon)
    assert cell_edge_distance_km(storm, lat, lon) == pytest.approx(centre - 10, abs=0.05)
    # The same storm turned north-south reaches only 4 km towards us.
    turned = Cell(lat=lat, lon=lon - 0.3, area_km2=125, major_km=10, minor_km=4, bearing=0)
    assert cell_edge_distance_km(turned, lat, lon) == pytest.approx(centre - 4, abs=0.05)
    # Standing inside a storm is 0 km.
    assert cell_edge_distance_km(storm, storm.lat, storm.lon + 0.01) == 0


def test_proximity_reports_nearest_storm_and_direction():
    lat, lon = BRISBANE
    near = Cell(lat=lat + 0.1, lon=lon - 0.1, area_km2=50, major_km=4, minor_km=4, bearing=0)  # NW
    far = Cell(lat=lat - 0.6, lon=lon, area_km2=50, major_km=4, minor_km=4, bearing=0)
    seen = proximity(snapshot([far, near]), lat, lon, radius_km=20)
    assert seen.in_coverage and seen.storms == 2
    assert seen.direction == "NW"
    assert seen.distance_km == pytest.approx(geo.haversine_km(lat, lon, near.lat, near.lon) - 4, abs=0.05)
    assert (seen.storm_lat, seen.storm_lon) == (near.lat, near.lon)
    assert seen.storms_within_radius == 1


def test_forecast_track_can_be_closer_than_the_storm():
    lat, lon = BRISBANE
    storm = Cell(lat=lat, lon=lon - 0.5, area_km2=50, major_km=4, minor_km=4, bearing=0)
    arc = [(lon - 0.4, lat), (lon - 0.2, lat), (lon - 0.05, lat)]  # heading our way
    seen = proximity(snapshot([storm], arc), lat, lon, radius_km=20)
    assert seen.distance_km > 40
    assert seen.forecast_km == pytest.approx(geo.haversine_km(lat, lon, lat, lon - 0.05), abs=0.01)
    assert seen.forecast_direction == "W"
    # With no arrows drawn, the forecast distance is the storm's own.
    alone = proximity(snapshot([storm]), lat, lon, radius_km=20)
    assert alone.forecast_km == pytest.approx(alone.distance_km)


def test_no_storms_and_out_of_coverage():
    clear = proximity(snapshot(), *BRISBANE, radius_km=20)
    assert clear.in_coverage and clear.storms == 0
    assert clear.distance_km is None and clear.forecast_km is None and clear.direction is None
    sydney = proximity(snapshot([Cell(-27.5, 153.0, 50, 4, 4, 0)]), -33.87, 151.21, radius_km=20)
    assert not sydney.in_coverage and sydney.distance_km is None and sydney.storms == 1


# ----- snapshot validation ---------------------------------------------------------


def test_parse_snapshot_accepts_what_the_bridge_sends():
    png = tracker_png()
    snap = parse_snapshot(
        make_payload(ISSUED_MS, cells=[cell(-27.5, 152.9)], forecast=[[152.95, -27.5]], image=png), now=NOW
    )
    assert snap.issued == datetime(2026, 11, 10, 5, 42, tzinfo=UTC)
    assert snap.cells == (Cell(-27.5, 152.9, 75.4, 6.0, 4.0, 90.0),)
    assert snap.forecast == ((152.95, -27.5),)
    assert snap.image_png == png
    assert snap.description.startswith("At 3:40 pm")
    heartbeat = parse_snapshot(make_payload(ISSUED_MS, description="  "), now=NOW)
    assert heartbeat.image_png is None and heartbeat.description is None and heartbeat.cells == ()


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (lambda p: p.update(v=2), "version"),
        (lambda p: p.update(issued="now"), "issued"),
        (lambda p: p.update(issued=ISSUED_MS + 3_600_000), "future"),
        (lambda p: p.update(hash="not hex!"), "hash"),
        (lambda p: p.update(cells="none"), "cells"),
        (lambda p: p.update(cells=[{"lat": -27.5}]), "cell lon"),
        (lambda p: p.update(cells=[cell(51.5, -0.1)]), "out of range"),
        (lambda p: p.update(cells=[{**cell(-27.5, 153.0), "major_km": float("nan")}]), "number"),
        (lambda p: p.update(cells=[{**cell(-27.5, 153.0), "lat": True}]), "number"),
        (lambda p: p.update(forecast=[[153.0]]), "forecast"),
        (lambda p: p.update(description=5), "description"),
        (lambda p: p.update(image={"w": 600, "h": 643, "png": "@@@"}), "base64"),
        (lambda p: p.update(image={"w": 600, "h": 643, "png": "aGVsbG8="}), "PNG"),
        (lambda p: p.update(image={"w": 512, "h": 512, "png": "aGVsbG8="}), "size"),
        (lambda p: p.update(image={"w": 600, "h": 643, "png": "A" * 2_000_000}), "too large"),
    ],
)
def test_parse_snapshot_rejects_bad_payloads(change, reason):
    payload = make_payload(ISSUED_MS, cells=[cell(-27.5, 152.9)])
    change(payload)
    with pytest.raises(SnapshotError, match=reason):
        parse_snapshot(payload, now=NOW)


def test_parse_snapshot_rejects_non_objects():
    for bad in (None, [], "x", 3):
        with pytest.raises(SnapshotError):
            parse_snapshot(bad, now=NOW)


# ----- drawing ---------------------------------------------------------------------


def test_check_tracker_png():
    check_tracker_png(tracker_png())
    with pytest.raises(ImageError, match="size"):
        check_tracker_png(tracker_png((512, 512)))
    with pytest.raises(ImageError):
        check_tracker_png(b"\x89PNG\r\n\x1a\nnot really")
    jpeg = BytesIO()
    Image.new("RGB", (600, 643)).save(jpeg, "JPEG")
    with pytest.raises(ImageError, match="PNG"):
        check_tracker_png(jpeg.getvalue())


def test_render_map_crops_around_the_place_and_marks_it():
    lat, lon = BRISBANE
    px, py = geo.lonlat_to_pixel(lon, lat)
    # A storm 60 px west of Brisbane (about 25 km).
    png = tracker_png(blobs=((round(px) - 60, round(py), 12, 8),))
    out = Image.open(BytesIO(render_map(png, lat=lat, lon=lon, radius_km=20, span_km=120)))
    assert out.format == "PNG"
    assert out.width == 720 and abs(out.height - 720) <= 2  # square on the ground
    rgb = out.convert("RGB")
    cx, cy = out.width // 2, out.height // 2
    assert rgb.getpixel((cx, cy)) == (26, 115, 232)  # the place marker, centred
    km_x, _ = geo.km_per_pixel(lat)
    scale = out.width / (120 / km_x)
    storm = rgb.getpixel((round(cx - 60 * scale), cy))
    assert storm[0] > 230 and 170 < storm[1] < 200 and storm[2] < 160  # storm colour survives, 25 km west
    ring = rgb.getpixel((round(cx + 20 / 120 * out.width), cy))
    assert ring == (26, 115, 232)  # the 20 km ring


def test_render_map_keeps_the_crop_inside_the_image_near_an_edge():
    lon, lat = geo.pixel_to_lonlat(590, 20)  # top-right corner of coverage
    out = Image.open(BytesIO(render_map(tracker_png(), lat=lat, lon=lon, radius_km=10, span_km=100))).convert("RGB")
    marker = [
        (x, y)
        for x in range(0, out.width, 4)
        for y in range(0, out.height, 4)
        if out.getpixel((x, y)) == (26, 115, 232)
    ]
    assert marker and min(x for x, _ in marker) > out.width * 0.75 and max(y for _, y in marker) < out.height * 0.4


def test_render_map_without_a_place_returns_the_whole_image():
    for where in ((None, None), (-33.87, 151.21)):
        out = Image.open(BytesIO(render_map(tracker_png(), lat=where[0], lon=where[1], radius_km=20, span_km=120)))
        assert out.size == (600, 643)
        assert math.isclose(out.convert("RGB").getpixel((300, 300))[0], 229)
