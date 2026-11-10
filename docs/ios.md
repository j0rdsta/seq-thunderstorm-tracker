# iPhone and iPad

Three ways to see the tracker on iOS. All of them read from your Home Assistant, so set that up
first: [Home Assistant: map card, storm distances and notifications](home-assistant.md).

## 1. A notification with the map

The [notification blueprint](home-assistant.md#notifications) attaches the place's map to the
alert. Long-press the notification to see it full size. This needs only the Home Assistant app.

## 2. A widget with the map (Scriptable)

The Home Assistant app's own widgets cannot show a picture, so the map widget uses
[Scriptable](https://scriptable.app), a free app that runs small scripts as widgets.

1. In Home Assistant, open your profile, then *Security*, and create a **long-lived access token**.
2. Install Scriptable. Add a new script, name it *SEQ Thunderstorm Tracker*, and paste in
   [`ios/SEQ Thunderstorm Tracker.js`](../ios/SEQ%20Thunderstorm%20Tracker.js).
3. Run it once. It asks for your Home Assistant address (the one you use away from home) and the
   token, and keeps both in the iOS Keychain.
4. Add a Scriptable widget to the Home Screen, long-press it, choose *Edit Widget* and pick the
   script.

The widget shows the map with the distance over it: `12 km NW`, `No storms`, or `No tracker data`
when the bridge has stopped. It also works as a Lock Screen widget, as text only. Tapping it opens
the Bureau's tracker page.

To watch a person instead of home, put the two entity names in the widget's **Parameter** field,
map first:

```
image.thunderstorms_near_jordan_map, sensor.thunderstorms_near_jordan_nearest_storm
```

iOS decides when widgets refresh, usually every 5 to 15 minutes. The widget asks for 5.

## 3. The distance in a Home Assistant widget

The Home Assistant app's **Sensors**, **Details** and **Gauge** widgets can show
`sensor.thunderstorms_near_home_nearest_storm`. No extra app, and no map.

## The dashboard card

The [card](home-assistant.md#the-card) works in the Home Assistant app like any other card. The
picture is loaded by your phone straight from the Bureau.
