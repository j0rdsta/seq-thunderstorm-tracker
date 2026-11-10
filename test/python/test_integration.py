"""The integration inside a test Home Assistant: setup, the webhook, entities and staleness."""

from __future__ import annotations

from datetime import timedelta
from io import BytesIO

from freezegun.api import FrozenDateTimeFactory
from PIL import Image
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from custom_components.seq_thunderstorm_tracker.const import DOMAIN

from helpers import BRISBANE, cell, make_payload, tracker_png

WEBHOOK_ID = "test-webhook-id"
HOME_LAT, HOME_LON = BRISBANE

NEAREST = "sensor.thunderstorms_near_home_nearest_storm"
TRACK = "sensor.thunderstorms_near_home_nearest_forecast_track"
NEARBY = "binary_sensor.thunderstorms_near_home_storm_nearby"
MAP = "image.thunderstorms_near_home_map"
STORMS = "sensor.seq_thunderstorm_tracker_tracked_storms"
ISSUED = "sensor.seq_thunderstorm_tracker_tracker_issued"
BRIDGE = "binary_sensor.seq_thunderstorm_tracker_bridge"
IMAGE = "image.seq_thunderstorm_tracker_tracker_image"


def now_ms() -> int:
    return int(dt_util.utcnow().timestamp() * 1000)


@pytest.fixture
async def entry(hass: HomeAssistant) -> MockConfigEntry:
    """The integration set up with Home (in Brisbane) as the one tracked place."""
    hass.config.latitude, hass.config.longitude = HOME_LAT, HOME_LON
    hass.config.location_name = "Home"
    assert await async_setup_component(hass, "zone", {})
    await hass.async_block_till_done()
    config_entry = MockConfigEntry(
        domain=DOMAIN,
        title="SEQ Thunderstorm Tracker",
        data={"webhook_id": WEBHOOK_ID},
        options={"targets": ["zone.home"], "radius_km": 20, "stale_minutes": 15, "map_span_km": 120},
    )
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry


@pytest.fixture
async def post(hass: HomeAssistant, entry: MockConfigEntry, hass_client_no_auth):
    """Post a payload to the webhook the way the bridge does (no login)."""
    client = await hass_client_no_auth()

    async def _post(payload, **kwargs):
        response = await client.post(f"/api/webhook/{WEBHOOK_ID}", json=payload, **kwargs)
        await hass.async_block_till_done()
        return response

    return _post


def storm_west(km: float = 40.0) -> dict:
    """A round 4 km storm centred ``km`` west of home."""
    return cell(HOME_LAT, HOME_LON - km / 98.7, major=4, minor=4, bearing=0)


async def test_config_flow_creates_entry_and_shows_webhook(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, "zone", {})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"targets": ["zone.home"], "radius_km": 25}
    )
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["options"] == {"targets": ["zone.home"], "radius_km": 25, "stale_minutes": 15, "map_span_km": 120}
    webhook_id = result["data"]["webhook_id"]
    assert len(webhook_id) >= 32
    assert f"/api/webhook/{webhook_id}" in result["description_placeholders"]["webhook_url"]
    # Only one instance.
    again = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert again["type"] is FlowResultType.ABORT


async def test_entities_are_unavailable_before_any_data(hass: HomeAssistant, entry) -> None:
    for entity_id in (NEAREST, TRACK, NEARBY, MAP, STORMS, IMAGE, ISSUED):
        assert hass.states.get(entity_id).state == "unavailable", entity_id
    assert hass.states.get(BRIDGE).state == "off"


async def test_snapshot_drives_distance_and_nearby(hass: HomeAssistant, entry, post) -> None:
    png = tracker_png()
    response = await post(
        make_payload(now_ms(), cells=[storm_west(40)], forecast=[[HOME_LON - 0.25, HOME_LAT]], image=png)
    )
    assert response.status == 200
    assert await response.json() == {"ok": True, "need_image": False}

    nearest = hass.states.get(NEAREST)
    assert float(nearest.state) == pytest.approx(36, abs=0.5)  # 40 km to the centre, 4 km radius
    assert nearest.attributes["direction"] == "W"
    assert nearest.attributes["storms"] == 1
    assert nearest.attributes["target"] == "zone.home"
    assert nearest.attributes["unit_of_measurement"] == "km"
    assert float(hass.states.get(TRACK).state) == pytest.approx(24.7, abs=0.5)
    nearby = hass.states.get(NEARBY)
    assert nearby.state == "off"
    assert nearby.attributes["radius_km"] == 20
    assert nearby.attributes["forecast_track_within_radius"] is False

    storms = hass.states.get(STORMS)
    assert storms.state == "1"
    assert storms.attributes["description"].startswith("At 3:40 pm")
    assert storms.attributes["cells"][0]["latitude"] == pytest.approx(HOME_LAT)
    assert hass.states.get(BRIDGE).state == "on"
    assert hass.states.get(ISSUED).state not in ("unknown", "unavailable")

    # The storm moves to 15 km away: nearby turns on.
    response = await post(make_payload(now_ms() + 1000, cells=[storm_west(15)], image=png, storm_hash="cd"))
    assert response.status == 200
    assert float(hass.states.get(NEAREST).state) == pytest.approx(11, abs=0.5)
    assert hass.states.get(NEARBY).state == "on"
    assert hass.states.get(NEARBY).attributes["storms_within_radius"] == 1


async def test_no_storms_reads_as_unknown_distance_and_not_nearby(hass: HomeAssistant, entry, post) -> None:
    await post(make_payload(now_ms(), image=tracker_png()))
    assert hass.states.get(STORMS).state == "0"
    assert hass.states.get(NEAREST).state == "unknown"
    assert hass.states.get(TRACK).state == "unknown"
    assert hass.states.get(NEARBY).state == "off"


async def test_stale_data_becomes_unavailable(
    hass: HomeAssistant, entry, post, freezer: FrozenDateTimeFactory
) -> None:
    await post(make_payload(now_ms(), cells=[storm_west(10)], image=tracker_png()))
    assert hass.states.get(NEARBY).state == "on"

    freezer.tick(timedelta(minutes=14))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(NEARBY).state == "on"

    freezer.tick(timedelta(minutes=2))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    for entity_id in (NEAREST, TRACK, NEARBY, MAP, STORMS, IMAGE):
        assert hass.states.get(entity_id).state == "unavailable", entity_id
    assert hass.states.get(BRIDGE).state == "off"
    assert hass.states.get(ISSUED).state != "unavailable"  # still says how old the last picture is

    # A heartbeat brings everything back.
    await post(make_payload(now_ms(), cells=[storm_west(10)]))
    assert hass.states.get(NEARBY).state == "on"
    assert hass.states.get(BRIDGE).state == "on"


async def test_a_snapshot_that_is_already_old_is_not_trusted(hass: HomeAssistant, entry, post) -> None:
    response = await post(make_payload(now_ms() - 20 * 60 * 1000, cells=[storm_west(10)], image=tracker_png()))
    assert response.status == 200
    assert hass.states.get(NEARBY).state == "unavailable"
    assert hass.states.get(BRIDGE).state == "off"


async def test_heartbeat_keeps_image_and_changed_storms_ask_for_it(hass: HomeAssistant, entry, post) -> None:
    png = tracker_png()
    assert (await (await post(make_payload(now_ms(), cells=[storm_west(30)], image=png))).json())["need_image"] is False
    # Same storms, no image: fine.
    reply = await (await post(make_payload(now_ms() + 1000, cells=[storm_west(30)]))).json()
    assert reply == {"ok": True, "need_image": False}
    assert hass.states.get(IMAGE).state != "unavailable"
    # New storms without their image: the old picture is dropped and the bridge is asked for the new one.
    reply = await (await post(make_payload(now_ms() + 2000, cells=[storm_west(20)], storm_hash="ee"))).json()
    assert reply == {"ok": True, "need_image": True}
    assert hass.states.get(IMAGE).state == "unavailable"
    assert float(hass.states.get(NEAREST).state) == pytest.approx(16, abs=0.5)


async def test_older_snapshot_is_ignored(hass: HomeAssistant, entry, post) -> None:
    t = now_ms()
    await post(make_payload(t, cells=[storm_west(30)], image=tracker_png()))
    reply = await (await post(make_payload(t - 60000, cells=[storm_west(5)], storm_hash="ff"))).json()
    assert reply["ok"] is True and "ignored" in reply
    assert float(hass.states.get(NEAREST).state) == pytest.approx(26, abs=0.5)


async def test_webhook_rejects_bad_requests(hass: HomeAssistant, entry, post, hass_client_no_auth) -> None:
    await post(make_payload(now_ms(), cells=[storm_west(30)], image=tracker_png()))
    for payload, reason in (
        ({"v": 9}, "version"),
        (make_payload(now_ms(), image=tracker_png((512, 512))), "size"),
        (make_payload(now_ms(), cells=[cell(51.5, -0.1)]), "range"),
    ):
        response = await post(payload)
        assert response.status == 400
        body = await response.json()
        assert body["ok"] is False and reason in body["error"]
    client = await hass_client_no_auth()
    assert (await client.post(f"/api/webhook/{WEBHOOK_ID}", data="not json")).status == 400
    assert (await client.post(f"/api/webhook/{WEBHOOK_ID}", data=b"x" * (2 * 1024 * 1024 + 10))).status == 413
    assert (await client.get(f"/api/webhook/{WEBHOOK_ID}")).status == 405
    # The earlier good snapshot is untouched.
    assert float(hass.states.get(NEAREST).state) == pytest.approx(26, abs=0.5)


async def test_image_entities_serve_the_tracker_and_a_marked_map(
    hass: HomeAssistant, entry, post, hass_client
) -> None:
    png = tracker_png(blobs=((300, 300, 14, 10),))
    await post(make_payload(now_ms(), cells=[storm_west(30)], image=png))
    client = await hass_client()

    raw = await client.get(f"/api/image_proxy/{IMAGE}")
    assert raw.status == 200 and raw.headers["Content-Type"] == "image/png"
    assert await raw.read() == png

    marked = await client.get(f"/api/image_proxy/{MAP}")
    assert marked.status == 200
    picture = Image.open(BytesIO(await marked.read())).convert("RGB")
    assert picture.width == 720
    assert picture.getpixel((picture.width // 2, picture.height // 2)) == (26, 115, 232)
    first_state = hass.states.get(MAP).state

    # A heartbeat does not redraw the map; a new picture does.
    await post(make_payload(now_ms() + 1000, cells=[storm_west(30)]))
    assert hass.states.get(MAP).state == first_state
    await post(make_payload(now_ms() + 2000, cells=[storm_west(25)], image=tracker_png(), storm_hash="0f"))
    assert hass.states.get(MAP).state != first_state


async def test_a_person_is_followed_as_they_move(hass: HomeAssistant, post, entry) -> None:
    hass.states.async_set("person.jordan", "not_home", {"latitude": HOME_LAT, "longitude": HOME_LON - 0.3, "friendly_name": "Jordan"})
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "targets": ["zone.home", "person.jordan"]}
    )
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    nearest = "sensor.thunderstorms_near_jordan_nearest_storm"
    await post(make_payload(now_ms(), cells=[storm_west(40)], image=tracker_png()))
    # Jordan is about 29.6 km west of home, so the storm centre is about 10 km further west.
    assert float(hass.states.get(nearest).state) == pytest.approx(6.4, abs=0.6)
    assert hass.states.get("binary_sensor.thunderstorms_near_jordan_storm_nearby").state == "on"
    assert hass.states.get(NEARBY).state == "off"

    # Jordan drives east, away from it.
    hass.states.async_set("person.jordan", "not_home", {"latitude": HOME_LAT, "longitude": HOME_LON + 0.2, "friendly_name": "Jordan"})
    await hass.async_block_till_done()
    assert float(hass.states.get(nearest).state) == pytest.approx(55.7, abs=1)

    # Home without GPS coordinates counts as being at Home Assistant's own location.
    hass.states.async_set("person.jordan", "home", {"friendly_name": "Jordan"})
    await hass.async_block_till_done()
    assert hass.states.get(nearest).state == hass.states.get(NEAREST).state

    # Away with no position at all: nothing to measure from.
    hass.states.async_set("person.jordan", "not_home", {"friendly_name": "Jordan"})
    await hass.async_block_till_done()
    assert hass.states.get(nearest).state == "unavailable"

    # Out of the tracker's coverage: no distance, and it says why.
    hass.states.async_set("person.jordan", "not_home", {"latitude": -33.87, "longitude": 151.21, "friendly_name": "Jordan"})
    await hass.async_block_till_done()
    assert hass.states.get(nearest).state == "unknown"
    assert hass.states.get(nearest).attributes["in_coverage"] is False
    assert hass.states.get("binary_sensor.thunderstorms_near_jordan_storm_nearby").state == "unknown"


async def test_dropping_a_place_removes_its_device(hass: HomeAssistant, entry) -> None:
    hass.states.async_set("person.jordan", "home", {"friendly_name": "Jordan"})
    hass.config_entries.async_update_entry(entry, options={**entry.options, "targets": ["zone.home", "person.jordan"]})
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    devices = dr.async_get(hass)
    assert len(dr.async_entries_for_config_entry(devices, entry.entry_id)) == 3

    hass.config_entries.async_update_entry(entry, options={**entry.options, "targets": ["zone.home"]})
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    names = {d.name for d in dr.async_entries_for_config_entry(devices, entry.entry_id)}
    assert names == {"SEQ Thunderstorm Tracker", "Thunderstorms near Home"}
    assert er.async_get(hass).async_get("sensor.thunderstorms_near_jordan_nearest_storm") is None


async def test_options_flow_shows_webhook_and_reloads(hass: HomeAssistant, entry) -> None:
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    assert f"/api/webhook/{WEBHOOK_ID}" in result["description_placeholders"]["webhook_url"]
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {"targets": ["zone.home"], "radius_km": 50, "stale_minutes": 20, "map_span_km": 200},
    )
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.runtime_data.radius_km == 50
    assert entry.runtime_data.stale_after == timedelta(minutes=20)
    assert entry.runtime_data.span_km == 200


async def test_card_is_served_and_registered(hass: HomeAssistant, entry, hass_client) -> None:
    from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL

    urls = hass.data[DATA_EXTRA_MODULE_URL].urls
    card = [u for u in urls if u.startswith("/seq_thunderstorm_tracker/frontend/seq-thunderstorm-tracker-card.js?v=")]
    assert len(card) == 1
    client = await hass_client()
    response = await client.get(card[0])
    assert response.status == 200
    assert "seq-thunderstorm-tracker-card" in await response.text()

    assert await hass.config_entries.async_unload(entry.entry_id)
    assert not [u for u in hass.data[DATA_EXTRA_MODULE_URL].urls if "seq-thunderstorm-tracker-card" in u]
    # The webhook is gone too (Home Assistant answers unknown webhooks with 200 and ignores them).
    assert WEBHOOK_ID not in hass.data["webhook"]
