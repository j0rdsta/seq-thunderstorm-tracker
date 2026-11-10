# Home Assistant: map card, storm distances and notifications

This adds three things to Home Assistant:

- a **dashboard card** with the Thunderstorm Tracker drawn on a map, your places marked and an alert ring
- **sensors** for how far the nearest tracked storm is from home or from a person
- a **notification** when a storm comes within a distance you choose, with a map attached

> **Unofficial.** Not affiliated with or endorsed by the Bureau of Meteorology. The tracker is a pilot
> product for Southeast Queensland. This is not a warning service: the Bureau's warnings come first.

## How the data gets there

Home Assistant never fetches anything from bom.gov.au. The Bureau turns away anything that is not a
browser, and this project does not work around that.

- **The card** loads the tracker picture in the browser of whoever is looking at the dashboard, the
  same way the Bureau's own page does. It needs nothing else to show storms on the map.
- **Distances and notifications** need to know where the storms are, and a dashboard on another
  site is not allowed to read the picture's pixels. So a small **bridge userscript** runs in your
  browser on a bom.gov.au tab, reads the picture there and sends the storm positions to your Home
  Assistant.

That means the sensors and notifications only work while a browser has a bom.gov.au tab open with
the bridge running. When it stops, the sensors go *unavailable* within 15 minutes. They never fall
back to "no storms".

## Install

1. Add this repository to Home Assistant:
   - **2026.11 or later:** *Settings → Marketplace → Add from link*, and paste
     `https://github.com/j0rdsta/seq-thunderstorm-tracker`.
   - **Earlier versions with HACS:** *HACS → ⋮ → Custom repositories*, add the same address as an
     *Integration*, then download it and restart Home Assistant.
   - **By hand:** copy `custom_components/seq_thunderstorm_tracker` into your `config/custom_components`
     folder and restart.
2. *Settings → Devices & services → Add integration → SEQ Thunderstorm Tracker*.
3. Choose the places to measure from (zones, people or device trackers) and the alert distance.
4. The last screen shows a **webhook address**. Copy it. You can find it again under *Configure*.
   Anyone with the address can send your Home Assistant storm data, so treat it like a password.

The card is installed with the integration. There is no separate resource to add.

## Set up the bridge

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Install the
   **[bridge userscript](https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker-ha-bridge.user.js)**.
3. Open a bom.gov.au location page, or the
   [Thunderstorm Tracker page](https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml).
4. In the userscript manager's menu choose **Set Home Assistant webhook address** and paste the
   address. The first time it sends, the manager asks whether the script may contact that address:
   allow it.

Use the address that works from wherever that browser is. The one ending in `ui.nabu.casa` (or
your own domain) works anywhere. A local address such as `http://homeassistant.local:8123/...`
only works on your home network.

A line appears on the page: `Home Assistant bridge: sent a minute ago, tracker issued 3:42 pm AEST
(14 storm cells)`. In Home Assistant, the **Bridge** sensor turns to *Connected*.

### Keeping it running

- Leave a bom.gov.au tab open on a computer that stays on. One tab does the sending. If you have
  several open, another takes over when the first closes.
- Chrome and Edge put idle background tabs to sleep. Add `bom.gov.au` under *Settings →
  Performance → Always keep these sites active*.
- The bridge looks at the tracker once every 5 minutes, in the background too. To send only while
  a tab is on screen, use the menu item **Background tabs: turn sending on or off**.

### What it asks of the Bureau

One conditional request for the tracker image every 5 minutes across all your open tabs, plus the
tracker page's text when the storms have changed. The picture is sent only to the address you gave
it.

## The card

Add it from the card picker (search for *Thunderstorm*), or in YAML:

```yaml
type: custom:seq-thunderstorm-tracker-card
entities:
  - zone.home
  - person.jordan
```

| Option | Default | What it does |
|---|---|---|
| `entities` | `[zone.home]` | Places to mark. The first is the centre of the map and gets the alert ring. |
| `title` | `Thunderstorm tracker` | Card heading. Leave empty for none. |
| `zoom` | `8` | 5 to 11. One tracker pixel is about 0.4 km, so there is nothing more to see past 11. |
| `alert_radius` | from the integration | Ring radius in km. |
| `source` | `auto` | `auto`: the Bureau's picture, then the one the bridge sent. `bom`: the Bureau only. `home_assistant`: the bridge's picture only. |
| `storm_colour` | `original` | `original` (orange), `magenta` or `black`. |
| `opacity` | `0.85` | 0.2 to 1. |
| `show_description` | `true` | The Bureau's plain-English tracking description, when the bridge is running. |
| `radar` | `false` | Rain radar underneath from [RainViewer](https://www.rainviewer.com/). It is another service's radar mosaic, not the Bureau's, and only goes to zoom 7. |

Under the map the card says what it is showing, for example `Tracker issued 3:42 pm AEST · 14 storm
cells · nearest 12 km NW of Home · forecast track within 3 km`. Without the bridge it says `Live
picture from the Bureau's Thunderstorm Tracker.` and shows no distances.

The base map is OpenStreetMap, through Home Assistant's own map tile proxy on 2026.10 and later.

## Entities

For the integration as a whole:

| Entity | What it is |
|---|---|
| `sensor.seq_thunderstorm_tracker_tracked_storms` | Number of storm cells. Attributes hold the Bureau's description and each cell's position and size. |
| `sensor.seq_thunderstorm_tracker_tracker_issued` | When the Bureau issued the picture behind the current numbers. Stays readable when the data is stale. |
| `binary_sensor.seq_thunderstorm_tracker_bridge` | *Connected* while fresh data is arriving. |
| `image.seq_thunderstorm_tracker_tracker_image` | The tracker picture as the browser received it. |

For each place you chose (shown here for Home):

| Entity | What it is |
|---|---|
| `sensor.thunderstorms_near_home_nearest_storm` | Distance in km to the edge of the nearest storm cell, with its compass direction as an attribute. |
| `sensor.thunderstorms_near_home_nearest_forecast_track` | Distance to the nearest part of the Bureau's arrows and 10, 20 and 30-minute arcs. Smaller than the storm distance when one is heading your way. |
| `binary_sensor.thunderstorms_near_home_storm_nearby` | *Unsafe* when a storm cell is within the alert distance. |
| `image.thunderstorms_near_home_map` | The tracker picture cropped around the place, with the place and alert ring marked. Used by notifications and the iOS widget. |

How the numbers behave:

- **No storms tracked:** the distances read *unknown* and *Storm nearby* is off.
- **Outside Southeast Queensland:** the distances read *unknown* and the `in_coverage` attribute is false.
- **A person with no position:** unavailable. Someone who is *home* without GPS counts as being at
  Home Assistant's own location.
- **Data older than 15 minutes** (change it under *Configure*): everything goes unavailable.

Distances are measured to the oval the Bureau drew, so they are as good as the tracker itself. The
picture is about 0.4 km per pixel and can be a kilometre or two out near its corners.

## Notifications

Import the blueprint:

[![Import the blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fj0rdsta%2Fseq-thunderstorm-tracker%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fseq_thunderstorm_tracker%2Fthunderstorm_nearby.yaml)

Then create an automation from it and choose:

- **Distance sensors:** the place's *Nearest storm*. Add *Nearest forecast track* too if you want to
  hear earlier, when the Bureau's forecast arcs reach the distance before the storm does.
- **Phone to notify**, the **distance**, and the place's **Map** image to attach.
- **Quiet time:** how long to wait before notifying again (30 minutes by default).

The notification reads like `Thunderstorm 12 km NW of Home. Bureau's Thunderstorm Tracker, 3:42 pm.
Not a warning: check current warnings.`

To follow yourself instead of your house, add your `person` entity as a place under the
integration's *Configure*, and use that person's sensors in the automation.

## Trying it without a storm

`scripts/replay.mjs` posts a tracker image you saved earlier to your webhook, exactly as the bridge
would:

```sh
node scripts/replay.mjs saved-tracker.png "https://your-home-assistant/api/webhook/..."
```

It only reads the file you give it.

## When something is wrong

- **The card shows a map but no storms:** there may be none. Check the
  [Thunderstorm Tracker page](https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml).
- **`The thunderstorm tracker picture could not be loaded`:** this browser could not reach the
  Bureau, and the bridge has not sent a picture either.
- **Sensors are unavailable:** the bridge is not sending. Look at the line it adds to the BoM page,
  or choose **Bridge status** in the userscript manager's menu.
- **`Home Assistant bridge: could not reach Home Assistant`:** the address is wrong for where that
  browser is, or the userscript manager was not allowed to contact it.
