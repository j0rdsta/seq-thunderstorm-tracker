## ADDED Requirements

### Requirement: Tracker data reaches Home Assistant only through a person's browser
The system SHALL NOT fetch bom.gov.au from Home Assistant, a server or a headless client. The bridge
userscript SHALL post snapshots from a browser tab on bom.gov.au, with at most one tracker image
request every 5 minutes across all open tabs.

#### Scenario: Two BoM tabs are open
- **WHEN** the bridge is installed and two BoM tabs are open
- **THEN** only one tab fetches and posts, and the other takes over when the first closes

#### Scenario: Storms have not changed since the last post
- **WHEN** the storm drawing hash equals the last one sent successfully
- **THEN** the snapshot is posted without the image, as a heartbeat

### Requirement: Distances come from the Bureau's drawing
The integration SHALL report, for each tracked zone or person, the distance to the edge of the
nearest tracked storm cell and the distance to the nearest part of the Bureau's forecast track
(arrows and 10, 20 and 30-minute arcs).

#### Scenario: A storm cell is near a tracked person
- **WHEN** a snapshot holds a cell whose edge is 12 km north-west of the person
- **THEN** the nearest storm sensor reads about 12 km with direction NW

#### Scenario: No storms are tracked
- **WHEN** a current snapshot holds no cells
- **THEN** the nearest storm sensor has no value and the storm nearby sensor is off

#### Scenario: The person is outside the tracker's coverage
- **WHEN** the person's position falls outside the tracker image footprint
- **THEN** the distance sensors have no value and report that the position is out of coverage

### Requirement: Stale data is never shown as clear skies
The integration SHALL mark its entities unavailable when the newest snapshot's issue time is older
than the configured limit (15 minutes by default).

#### Scenario: The browser tab is closed during a storm
- **WHEN** no snapshot arrives and the last issue time passes the limit
- **THEN** the distance and nearby sensors become unavailable and the bridge sensor turns off

### Requirement: Snapshots are validated before use
The integration SHALL reject a snapshot that is malformed, oversized, older than the one it holds,
or whose image is not a 600 by 643 PNG.

#### Scenario: A payload carries an image of another size
- **WHEN** the webhook receives an image that is not 600 by 643
- **THEN** it answers 400 and keeps the previous snapshot

### Requirement: The card shows the tracker without the bridge
The dashboard card SHALL display the live tracker image loaded by the viewer's browser from BoM,
aligned on the map with the same georeference as the userscript, and SHALL fall back to the image
held by Home Assistant when BoM's image fails to load.

#### Scenario: The integration has no data
- **WHEN** the card loads and BoM's image loads in the browser
- **THEN** storms are drawn on the map and the footer says the picture is live from the Bureau
