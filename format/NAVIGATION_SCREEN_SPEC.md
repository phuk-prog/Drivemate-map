# Category 7.1: Navigation Screen Specification

## Overview

The Navigation Screen is the primary interface during active route navigation. It displays the user's current location on an interactive map, provides turn-by-turn guidance, and manages the routing session.

## Core Components

### 1. Map View (Main Area)
- **Purpose**: Display DMAP features with current location overlay
- **Content**:
  - Road network (edges colored by class: motorway, trunk, primary, etc.)
  - Non-routed features (rail, transit, rivers, boundaries)
  - Area features (buildings, water, parks, land use)
  - Named labels (places, roads, POIs, house numbers)
  - Current location indicator (GPS position)
  - Route path (highlighted or distinct color from normal roads)
  - Upcoming turn indicator (next turn point)
- **Interactions**:
  - Pinch-zoom to adjust zoom level (within DMAP bounds)
  - Pan to move viewport
  - Rotate/tilt for perspective view (optional)
  - Long-press on features for details
  - Tap to dismiss panels or reset view

### 2. Turn Guidance Panel
- **Position**: Top-left or top-right corner, persistent
- **Content**:
  - Distance to next turn (meters/feet, auto-convert)
  - Turn direction indicator (left, right, straight, U-turn, etc.)
  - Road name of current road
  - Road name of next road (after turn)
  - Lane guidance (if available from lanes data):
    - Visual lane diagram or text (e.g., "left|through|right")
    - Highlight recommended lane
  - Turn restriction warnings (if applicable)
  - Speed limit sign (if available, with unit indicator)
  - Road classification icon (motorway, trunk, primary, etc.)
- **Layout**: Compact when route is far, expanded when turn is near
- **States**:
  - **Normal**: Standard turn information
  - **Imminent** (<300m): Highlight/enlarge turn instruction
  - **Arriving**: Show destination info instead of next turn
  - **Off-route**: Show rerouting status or prompt to reroute

### 3. Route Information Bar
- **Position**: Top area (below turn guidance) or collapsible
- **Content**:
  - Remaining distance to destination
  - Estimated time of arrival (ETA)
  - Total route distance
  - Current speed (if GPS enabled)
  - Traffic status (if data available)
- **Interactions**:
  - Tap to expand/collapse detail view
  - Swipe to show waypoints or alternate routes

### 4. Location Indicator
- **Style**: 
  - Blue dot for current position (standard map convention)
  - Circle or accuracy radius around position
  - Arrow/chevron showing direction of travel (heading)
- **Behavior**:
  - Center map on location when first starting navigation
  - Smoothly track location during travel
  - Auto-recenter after user pans away (optional, with "recenter" button)
- **Accuracy Display** (optional):
  - Show GPS accuracy level (good/fair/poor)
  - Visual feedback on signal strength

### 5. Controls & Buttons

#### Top-Left Controls
- **Menu/Close**: Exit navigation, return to main map
- **Route Options** (optional): View alternate routes, adjust preferences

#### Bottom-Right Controls
- **Recenter**: Auto-pan map to current location (if location has drifted)
- **Zoom In/Out** (optional): Manual zoom controls
- **Rotate/Compass** (optional): Reset map orientation to north

#### Bottom Area
- **Destination/Waypoint Panel**:
  - Show current destination name and address
  - Upcoming waypoints (if route has multiple stops)
  - Distance and ETA to destination
  - Buttons: "Arrived" or "Dismiss" options
- **Reroute Button**: Visible if off-route, triggers new route calculation
- **Voice/Sound Toggle**: Enable/disable turn-by-turn audio (if implemented)

### 6. Status Indicators

#### Navigation Status
- **On Route**: Green indicator
- **Off Route**: Red/orange indicator, shows distance off route
- **Arriving**: Special state, prepares for arrival
- **Ended**: Route completed, options to dismiss or save

#### Data Availability Flags
- **Roads**: Loaded for current zoom/viewport
- **Lanes**: Available for this road (show lane indicator)
- **Speed Limit**: Known for current road (show sign)
- **Turn Restrictions**: Applicable turn restrictions available
- **Labels**: Place names, road names displayed
- **GPS**: Signal strength, accuracy

### 7. Warnings & Alerts

#### Displayed Warnings (from DMAP warnings section)
- **Speed Cameras**: Icon/marker at location
- **Level Crossings**: Rail crossing indicator
- **Road Works**: Construction zone alert
- **Weather/Traffic** (if external data available)

#### User Alerts
- **Approaching Restricted Turn**: Show restriction type
- **Multiple Lane Changes Required**: Alert sequence of turns
- **Toll Road**: Warn if entering toll section
- **Low GPS Signal**: Alert if location accuracy poor

## Data Integration

### DMAP Features Used
| Feature | Usage |
|---------|-------|
| Nodes | Junction points, route waypoints |
| Edges | Road network, route path, display |
| Lines | Rail, transit, rivers, boundaries, footpaths |
| Polygons | Buildings, water, parks, land use, sports |
| Labels | Road names, place names, POIs, water names |
| Restrictions | Turn restrictions at nodes |
| Lanes | Lane guidance text for turn-by-turn |
| Warnings | Speed cameras, level crossings, road works |
| Speed Limits | Posted speed limits on roads |
| Road Names | Current and upcoming road names |

### External Data Needed
- **Route Path**: From routing engine (outside DMAP scope)
- **GPS Position**: From device location services
- **Current Speed**: From GPS data (optional)
- **Heading/Bearing**: From GPS compass/accelerometer
- **Time/ETA**: System clock + routing time estimate
- **Traffic Data** (optional): Real-time traffic conditions
- **Voice Guidance** (optional): Text-to-speech or audio files

## Interaction Flows

### Starting Navigation
1. User selects destination from search/map
2. Route is calculated (external routing engine)
3. Navigation screen opens, map centers on current location
4. Turn guidance panel shows first turn
5. Location tracking begins

### During Navigation
1. Map continuously updates for current location
2. Turn guidance updates as user approaches turns
3. System checks for off-route conditions
4. Lane guidance updates as user approaches turn
5. Speed limit signs update when on different roads
6. Warnings shown when approaching special features

### User Actions During Navigation
- **Pan map**: Map follows user dragging
- **Tap recenter**: Re-center on current location
- **Tap turn info**: Show full turn details (modal/expanded view)
- **Tap destination**: Show destination details
- **Tap reroute** (if off-route): Trigger new route calculation
- **Tap menu**: Pause navigation, show options

### Ending Navigation
1. User arrives at destination (GPS proximity check)
2. "Arrived" notification shown
3. User dismisses or confirms arrival
4. Option to rate route or save trip
5. Return to main map view

## Responsive Design Considerations

### Portrait Mode (Phone)
- Map takes full area except for overlays
- Turn guidance panel: compact, top portion
- Controls: bottom area, easy thumb reach
- Waypoint list: swipe-up from bottom

### Landscape Mode (Phone)
- Map takes most area
- Turn guidance panel: side panel (left or right)
- Controls: bottom corners
- Compact routing info bar

### Tablet/Large Screen
- Wider turn guidance panel (side bar)
- Optional map minimap/overview
- More expansive route information display
- Multi-column layout possible

### Accessibility Considerations
- Touch targets: minimum 44x44 dp
- Color not sole indicator (use icons/text)
- High contrast mode support
- Voice guidance as alternative to visual
- Screen reader compatible labels

## Performance Requirements

- **Map rendering**: Smooth 60 FPS during panning/zooming
- **Location updates**: 1Hz minimum (1 update per second)
- **Route update calculation**: <2 seconds for visible area
- **Turn guidance response**: <100ms latency when turn triggers
- **Label rendering**: Prioritize visible labels, LOD for density
- **Memory**: Fit DMAP into device RAM with room for routing
- **Power**: Optimize GPS and map rendering for battery life

## States & Transitions

```
[Starting Route]
    ↓
[Navigation] ← map pan/recenter → [Map Focused]
    ↓ (user off-route)
[Off Route] → [Rerouting] → [Navigation]
    ↓ (approach destination)
[Arriving]
    ↓
[Arrived] → [Confirmation] → [Done]
```

## Configuration & Settings

- **Map style** (light/dark, street/satellite)
- **Turn guidance verbosity** (brief/detailed)
- **Voice guidance** on/off, volume level
- **Speed unit** (km/h, mph)
- **Distance unit** (km, miles, meters, feet)
- **Recenter behavior** (always on, manual, never)
- **Zoom level** (auto, fixed)
- **Show traffic** on/off
- **Show POIs** on/off

## Future Enhancements

- 3D perspective map view
- AR (Augmented Reality) navigation overlay
- Live traffic integration
- Voice commands
- Real-time traffic incidents/accidents
- Scenic route vs fastest route options
- Favorites/recent destinations
- Trip statistics and history
