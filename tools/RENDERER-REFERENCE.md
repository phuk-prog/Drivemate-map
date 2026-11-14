# Drivemate Map Renderer - Reference Implementation

**Category**: 3.1-3.4 (Offline base map, route/position drawing, camera, styles/performance)

**Status**: Reference implementation for app developers

---

## Overview

This document describes how to render DMAP (Drivemate Map) files in a mobile app or web application. It provides reference code and design patterns for the four core rendering categories.

## DMAP File Format

See `format/FORMAT.md` for the complete specification. Key points:

- **Binary format** with fixed header (44 bytes)
- **Coordinate storage**: Signed 32-bit integers as 1e-7 degree units (~1.1 cm precision)
- **Features**: Nodes, edges (roads), lines (non-routed), polygons (areas), labels
- **Versions**: 3-8 (current is 8 with road names)
- **Sections**: Nodes, edges, lines, polygons, labels, restrictions, lanes, warnings, speedLimits, roadNames

---

## Category 3.1: Offline Base Map Rendering

### Overview

Render DMAP features with proper styling, layer ordering, and coordinate transformation.

### File Reading

The reference reader `tools/dmap.mjs` provides the pattern:

1. **Read header** (44 bytes fixed)
   - Magic: 4 bytes ("DMAP")
   - Version: u16
   - Reserved: u16
   - Bounding box: 4 x i32 (minLat, minLon, maxLat, maxLon in fixed-7 format)
   - Feature counts: 5 x u32

2. **Read sections** in order
   - Nodes: nodeCount records of [lat: i32, lon: i32]
   - Edges: edgeCount records of variable length
   - Lines: lineCount records of variable length
   - Polygons: polygonCount records with ring support
   - Labels: labelCount records with UTF-8 names
   - Restrictions, lanes, warnings, speedLimits, roadNames (version-dependent)

### Coordinate System

- **Fixed-7 representation**: `coord_degrees = fixed7_int / 1e7`
- **Projection**: Equirectangular with longitude scaling by cos(latitude)
  ```
  pixelX = (lon - centerLon) * cos(centerLat) * pixelsPerDegree * zoom + panX
  pixelY = (centerLat - lat) * pixelsPerDegree * zoom + panY
  ```
- **Pixels per degree**: ~111,319.5 pixels (at sea level)

### Rendering Order (Back to Front)

1. **Base map areas** (polygons) - from back to front by kind
   - Land cover: wood, grass, farmland, sand, wetland, residential, industrial, commercial, institutional, sports, cemetery, rock
   - Water bodies
   - Buildings
   - Piers

2. **Non-routed lines** (rail, transit, waterways, paths, boundaries)

3. **Roads** (edges) - from minor to major class
   - Class 8 (track) → Class 1 (motorway)
   - Use road class for visual hierarchy

4. **Labels** (optional - draws text at anchor points)

5. **Overlays** (routes, warnings, current position)

### Styling Reference

See `tools/preview.mjs` for complete color definitions. Summary:

**Areas (polygons)** - RGB hex colors:
```
Water: #AAD3DF          Building: #DAD0C4
Park: #CDE6BE           Wood: #A8D0A0
Grass: #D4EABC          Farmland: #ECE8CC
Sand: #F6EACC           Wetland: #C8DED2
Residential: #ECE4DC    Industrial: #E0DADE
Commercial: #F2DED8     Institutional: #E6E0F0
Sports: #C4E8CC         Cemetery: #CCE4CC
Rock: #D8D2CC           Pier: #BEB4AA
```

**Lines** - by kind:
```
Rail: #969696 (1px)
Transit: #AA82BE (1px, dashed)
Ferry: #78A0D2 (1px, dashed)
River: #96C8E6 (2px)
Canal: #96C8E6 (1px)
Stream: #AAD7F0 (1px)
Footpath: #C8BEB4 (1px, dashed)
Pier: #A0968C (1px)
Boundary: #C85A96 (1px, dashed)
```

**Roads** - by class:
```
Class 1 (Motorway): #E97878 (3px)
Class 2 (Trunk): #F0A06E (3px)
Class 3 (Primary): #FAC878 (3px)
Class 4 (Secondary): #FAE196 (2px)
Class 5 (Tertiary): #FFFFFF (2px)
Class 6 (Minor): #FFFFFF (2px)
Class 7 (Service): #EBEBEB (1px)
Class 8 (Track): #BEB4AA (1px)
```

### Fill Rules

- **Polygons**: Use even-odd fill rule (so holes are cut out correctly)
- **Line joins**: Round (for visual quality)
- **Line caps**: Round

### Performance Considerations

- **Culling**: Only draw features within visible viewport
- **Layer batching**: Group rendering by type and class for better caching
- **Tile-based rendering**: Consider subdividing large maps into 256x256 or 512x512 pixel tiles
- **Level-of-detail**: At zoom < 0.5, simplify roads; at zoom > 2, show all detail
- **Caching**: Pre-compute projected coordinates or use WebGL for dynamic updates

---

## Category 3.2: Route and Position Drawing

### Overview

Render dynamic overlays for user routes, current position, and navigation state.

### Route Rendering

Routes are polylines connecting waypoints or following road edges. Rendering pattern:

1. **Polyline**: Draw as a colored line on top of base map
   - Color: Typically bright (blue, green, or app theme color)
   - Width: Scale with zoom level (2-4px at normal zoom)
   - Style: Solid or gradient for navigation progress
   - Order: Draw after base map, before position indicator

2. **Waypoint markers**: Circle or icon at each waypoint
   - Start: Green or app theme
   - Intermediate: Blue or neutral
   - Destination: Red or app theme
   - Size: ~20-30px diameter

3. **Navigation progress**: Highlight the next segment differently
   - Color gradient from start (faded) to current position
   - Thicker line for visual emphasis

### Position and Heading

1. **Current position**: Circle marker at device location
   - Outer ring: Accuracy indicator (expands with GPS uncertainty)
   - Inner dot: Precise position
   - Color: Typically blue or teal
   - Size: ~15-25px

2. **Heading indicator**: Arrow or cone showing compass direction
   - Extends from current position
   - Angle matches device compass reading
   - Color: Slightly darker than position marker
   - Fades out when heading confidence is low

### Rotation Handling

When map is rotated to match heading:
- All coordinates must be rotated around center point
- Update heading indicator accordingly
- Recalculate viewport frustum for culling

### Implementation Pattern (Pseudocode)

```javascript
function renderRoute(route, zoom, isActive) {
  const lineWidth = 2 + zoom * 0.5;  // Scale with zoom
  const color = isActive ? "#007AFF" : "#999999";
  
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  
  ctx.beginPath();
  const [x0, y0] = project(route[0].lat, route[0].lon);
  ctx.moveTo(x0, y0);
  
  for (let i = 1; i < route.length; i++) {
    const [x, y] = project(route[i].lat, route[i].lon);
    ctx.lineTo(x, y);
  }
  
  ctx.stroke();
  
  // Draw waypoint markers
  for (let i = 0; i < route.length; i++) {
    const [x, y] = project(route[i].lat, route[i].lon);
    ctx.fillStyle = i === 0 ? "#4CAF50" : (i === route.length - 1 ? "#F44336" : "#2196F3");
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderPosition(lat, lon, heading, accuracy, zoom) {
  const [x, y] = project(lat, lon);
  
  // Accuracy circle
  const accuracyRadius = accuracy * 111319.5 * zoom;
  ctx.fillStyle = "rgba(33, 150, 243, 0.1)";
  ctx.beginPath();
  ctx.arc(x, y, accuracyRadius, 0, Math.PI * 2);
  ctx.fill();
  
  // Position marker
  ctx.fillStyle = "#2196F3";
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
  
  // Heading indicator
  if (heading !== undefined) {
    const angle = heading * Math.PI / 180;
    const len = 20;
    const x1 = x + Math.sin(angle) * len;
    const y1 = y - Math.cos(angle) * len;
    
    ctx.strokeStyle = "#1976D2";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}
```

---

## Category 3.3: Camera Management

### Overview

Manage viewport (camera) position, zoom, and rotation for interactive map navigation.

### Viewport State

```javascript
const viewport = {
  centerLat,    // Latitude at screen center
  centerLon,    // Longitude at screen center
  zoom,         // Scale factor (1 = natural, >1 = zoomed in, <1 = zoomed out)
  rotation,     // Map rotation in degrees (0 = north up, 90 = east up)
  panX,         // Pixel offset from calculated center
  panY          // Pixel offset from calculated center
};
```

### Zoom Levels

- **0.1-0.3**: Region overview (multiple cities/regions visible)
- **0.3-1.0**: City/county level (single city or area visible)
- **1.0-2.0**: Street level (individual streets visible)
- **2.0-5.0**: Detailed street view (fine detail visible)
- **5.0-10.0**: Extreme zoom (building details)

### Pan Operations

```javascript
function pan(deltaX, deltaY) {
  viewport.panX += deltaX;
  viewport.panY += deltaY;
}
```

### Zoom Operations

```javascript
function zoom(factor, centerX, centerY) {
  // Zoom keeps screen position fixed
  const oldZoom = viewport.zoom;
  viewport.zoom *= factor;
  
  // Adjust pan to keep zoom center on screen
  viewport.panX += centerX * (1 - factor);
  viewport.panY += centerY * (1 - factor);
}

function fitBounds(minLat, minLon, maxLat, maxLon, padding = 0.95) {
  viewport.centerLat = (minLat + maxLat) / 2;
  viewport.centerLon = (minLon + maxLon) / 2;
  
  const height = maxLat - minLat;
  const width = (maxLon - minLon) * Math.cos(viewport.centerLat * Math.PI / 180);
  const zoomX = screenWidth / (width * 111319.5);
  const zoomY = screenHeight / (height * 111319.5);
  viewport.zoom = Math.min(zoomX, zoomY) * padding;
  
  viewport.panX = 0;
  viewport.panY = 0;
}
```

### Rotation

```javascript
function setRotation(degrees) {
  viewport.rotation = degrees % 360;
}

function rotateAroundPoint(degrees, centerX, centerY) {
  // Rotate map around screen point
  viewport.rotation = (viewport.rotation + degrees) % 360;
  
  // Adjust pan to keep rotation center on screen
  const rad = degrees * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  const dx = centerX - screenWidth / 2;
  const dy = centerY - screenHeight / 2;
  viewport.panX += dx * (1 - cos) + dy * sin;
  viewport.panY += dy * (1 - cos) - dx * sin;
}
```

### Animation

Smooth transitions between viewport states:

```javascript
function animateViewport(fromView, toView, duration) {
  const startTime = Date.now();
  const easing = (t) => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;  // ease-in-out
  
  function frame() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(1, elapsed / duration);
    const eased = easing(progress);
    
    viewport.centerLat = fromView.centerLat + (toView.centerLat - fromView.centerLat) * eased;
    viewport.centerLon = fromView.centerLon + (toView.centerLon - fromView.centerLon) * eased;
    viewport.zoom = fromView.zoom * Math.pow(toView.zoom / fromView.zoom, eased);
    viewport.rotation = interpolateAngle(fromView.rotation, toView.rotation, eased);
    
    render();
    
    if (progress < 1) requestAnimationFrame(frame);
  }
  
  requestAnimationFrame(frame);
}
```

### Gesture Handling

**Pan** (1 finger drag):
```javascript
canvas.addEventListener("mousemove", (e) => {
  if (dragging) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    pan(dx, dy);
    lastX = e.clientX;
    lastY = e.clientY;
    render();
  }
});
```

**Pinch Zoom** (2 finger pinch):
```javascript
canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2) {
    const touch1 = e.touches[0];
    const touch2 = e.touches[1];
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    const newDist = Math.sqrt(dx*dx + dy*dy);
    
    const centerX = (touch1.clientX + touch2.clientX) / 2;
    const centerY = (touch1.clientY + touch2.clientY) / 2;
    
    zoom(newDist / lastDist, centerX, centerY);
    lastDist = newDist;
    render();
  }
});
```

**Rotate** (2 finger twist):
```javascript
function getTouchAngle(touch1, touch2) {
  return Math.atan2(touch2.clientY - touch1.clientY, touch2.clientX - touch1.clientX);
}

// In touchmove handler:
const angle = getTouchAngle(touch1, touch2);
const deltaAngle = (angle - lastAngle) * 180 / Math.PI;
rotateAroundPoint(deltaAngle, centerX, centerY);
lastAngle = angle;
```

---

## Category 3.4: Styles and Performance

### Styling System

#### Theme Colors

**Light theme**:
```
Background: #f0ede7
Primary: #007AFF
Secondary: #5AC8FA
Success: #4CAF50
Warning: #FF9500
Error: #F44336
```

**Dark theme** (prefers-color-scheme: dark):
```
Background: #1a1a1a
Primary: #007AFF (lighter shade: #0A84FF)
Secondary: #5AC8FA
Surface: #2a2a2a
Text: #FFFFFF
Text Secondary: #AAAAAA
```

#### Dynamic Styling

Adjust styles based on zoom level:

```javascript
function getStyleForZoom(zoom) {
  if (zoom < 0.5) {
    return { roadWidth: 0.5, lineWidth: 0.25, areaAlpha: 0.8 };
  } else if (zoom < 1) {
    return { roadWidth: 1, lineWidth: 0.5, areaAlpha: 0.9 };
  } else if (zoom < 3) {
    return { roadWidth: 2, lineWidth: 1, areaAlpha: 1 };
  } else {
    return { roadWidth: 3, lineWidth: 1.5, areaAlpha: 1 };
  }
}
```

### Performance Optimization

#### 1. Viewport Culling

Only render features within visible bounds:

```javascript
function isInViewport(lat, lon, padding = 0.01) {
  // Get visible bounds accounting for rotation and zoom
  const viewportBounds = calculateVisibleBounds(viewport, canvas);
  
  return lat >= viewportBounds.minLat - padding &&
         lat <= viewportBounds.maxLat + padding &&
         lon >= viewportBounds.minLon - padding &&
         lon <= viewportBounds.maxLon + padding;
}
```

#### 2. Tile-Based Rendering

Divide map into tiles for faster rendering:

```javascript
const TILE_SIZE = 256; // pixels

function getTilesInViewport() {
  const bounds = calculateVisibleBounds(viewport, canvas);
  const tiles = [];
  
  // Convert bounds to tile coordinates
  const minTile = latLonToTile(bounds.minLat, bounds.minLon, TILE_SIZE);
  const maxTile = latLonToTile(bounds.maxLat, bounds.maxLon, TILE_SIZE);
  
  for (let tileX = minTile.x; tileX <= maxTile.x; tileX++) {
    for (let tileY = minTile.y; tileY <= maxTile.y; tileY++) {
      tiles.push({ x: tileX, y: tileY });
    }
  }
  
  return tiles;
}

function renderTile(tile) {
  const bounds = tileToLatLon(tile.x, tile.y, TILE_SIZE);
  
  // Render only features in this tile's bounds
  for (const road of roadsInBounds(bounds)) {
    renderRoad(road);
  }
  
  for (const area of areasInBounds(bounds)) {
    renderArea(area);
  }
}
```

#### 3. Simplification

Reduce point count for distant features:

```javascript
function simplifyPolyline(points, tolerance) {
  if (points.length <= 2) return points;
  
  const result = [points[0]];
  
  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointToLineDistance(points[i], points[0], points[points.length - 1]);
    if (dist > tolerance) {
      result.push(points[i]);
    }
  }
  
  result.push(points[points.length - 1]);
  return result;
}
```

#### 4. Batching

Group rendering operations by type:

```javascript
function render() {
  // Clear
  ctx.fillRect(0, 0, width, height);
  
  // Batch 1: Areas (all at once with clipping)
  ctx.globalCompositeOperation = "destination-over";
  for (const polygon of visiblePolygons) {
    renderPolygon(polygon);
  }
  
  // Batch 2: Lines
  ctx.globalCompositeOperation = "source-over";
  for (const line of visibleLines) {
    renderLine(line);
  }
  
  // Batch 3: Roads (grouped by class)
  for (const roadClass of [8, 7, 6, 5, 4, 3, 2, 1]) {
    ctx.strokeStyle = ROAD_STYLE[roadClass].color;
    ctx.lineWidth = ROAD_STYLE[roadClass].width;
    for (const road of roadsByClass[roadClass]) {
      renderRoad(road);
    }
  }
  
  // Batch 4: Overlays (routes, position)
  renderRoute(route);
  renderPosition(currentPosition);
}
```

#### 5. WebGL Rendering (Advanced)

For high-performance rendering, use WebGL:

- Render base map to WebGL texture
- Update only changed tiles
- Use shaders for coordinate transformation
- Hardware acceleration for zooming/panning
- Offscreen rendering for complex features

#### 6. Memory Management

- Pre-allocate buffers for common operations
- Reuse coordinate arrays
- Cache projected coordinates
- Clean up large feature arrays when zooming out
- Limit label rendering to visible labels only

### Mobile Performance Considerations

- **Target 60 FPS**: Aim for 16.67ms per frame
- **Reduce draw calls**: Batch similar operations
- **Minimize allocations**: Reuse arrays and objects
- **Profile on actual devices**: Chrome DevTools remote debugging
- **Test on low-end devices**: Ensure 30 FPS minimum

---

## Reference Implementation

A complete working reference is provided in `tools/map-viewer.html`:

- Full DMAP reader (all versions)
- Canvas-based rendering with all feature types
- Interactive viewport (pan, zoom, rotate)
- Layer toggling and statistics
- Light/dark theme support
- Mobile touch support
- Responsive design

Usage:
```bash
# Open in browser
open tools/map-viewer.html

# Or serve locally
python3 -m http.server 8000
# Then navigate to http://localhost:8000/tools/map-viewer.html
```

Load a DMAP file via the UI and test rendering, navigation, and performance.

---

## Testing Checklist

- [ ] All DMAP versions (3-8) load correctly
- [ ] Coordinate projection is accurate
- [ ] All feature types render (nodes, edges, lines, polygons, labels)
- [ ] Styling matches reference (colors, widths, dash patterns)
- [ ] Viewport operations work (pan, zoom, rotate)
- [ ] Layer toggling works correctly
- [ ] No memory leaks on extended use
- [ ] Smooth 60 FPS performance at normal zoom
- [ ] Responsive design on mobile/tablet
- [ ] Light and dark themes render correctly
- [ ] Touch gestures work on mobile
- [ ] Labels don't cause text rendering issues
- [ ] Rotated coordinates project correctly

---

## Known Limitations

- Labels are stored in DMAP but not rendered in reference (text rendering is platform-specific)
- Restrictions and lanes are present in file but not visualized
- Speed limits and warnings are visible but not integrated into routing UI
- No real-time updates (map is static after load)
- No offline routing (reference is display-only)

---

## Related Documentation

- `format/FORMAT.md` - DMAP binary format specification
- `tools/dmap.mjs` - JavaScript reference implementation
- `tools/preview.mjs` - PNG rasterizer reference
- `README.md` - Build pipeline overview

---

## Next Steps

1. **3.1 Base Map**: Render DMAP in app using this reference
2. **3.2 Route Drawing**: Add route overlay using provided patterns
3. **3.3 Camera**: Implement viewport management
4. **3.4 Performance**: Optimize rendering using provided techniques
5. **Testing**: Validate against reference implementation

---

*Last Updated: 2026-11-14*  
*Reference Implementation: tools/map-viewer.html (Canvas, responsive, light/dark theme)*
