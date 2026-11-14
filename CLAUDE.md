# Drivemate Map - Project Structure

This document outlines the work categories for Drivemate's map data and app integration project.

## Project Overview

Drivemate-map handles downloadable map areas using OpenStreetMap data. The project is divided into logical categories covering:
- Map data format and build tools
- Mobile app UI and navigation
- Cross-device design patterns

---

## Category 1-6: Map Data & Build System
(See README.md and format/FORMAT.md)

- Vector tile fetching and processing
- DMAP binary format (v3-v8)
- Road graph building and optimization
- OSM restriction/lane/warning extraction
- Map preview and validation

---

## Category 7: Navigation UI & Device Adaptation

Work items for mobile app UI screens and design systems.

### 7.1 Navigation Screen

**Purpose**: Core navigation/route display interface for the mobile app.

**Scope**:
- Route display on main map view
- Current location indicator
- Turn-by-turn instructions panel
- Destination and waypoint management
- Speed/traffic indicators (if applicable)
- Navigation state management (routing, rerouting, arrival)

**Considerations**:
- Real-time position updates
- Map interaction (pan, zoom, rotate)
- Display of road names, turn lanes, warnings
- Integration with DMAP labels and features

**Status**: Starting work

---

### 7.2 Main Map View

**Purpose**: Base interactive map rendering and interaction layer.

**Scope**:
- DMAP file rendering
- Road/line/polygon/label display
- Viewport management and tile loading
- Zoom level adaptation
- Touch gestures (pan, pinch-zoom, rotate)
- POI/landmark display

---

### 7.3 Other Screens

**Purpose**: Supporting UI screens for app functionality.

**Scope**:
- Map download/management screen
- Settings and preferences
- Search and place selection
- Offline map status display
- Trip history or recents

---

### 7.4 Design System

**Purpose**: Unified visual language and component library.

**Scope**:
- Color palette and theming (light/dark)
- Typography and text styles
- Button and control designs
- Icon set
- Layout grid and spacing rules
- Navigation patterns
- Component reusability guidelines

---

### 7.5 Adapting to Devices

**Purpose**: Responsive design for various screen sizes and device capabilities.

**Scope**:
- Portrait and landscape orientation handling
- Phone vs tablet layout differences
- Screen size breakpoints (small/medium/large)
- Touch target sizing for accessibility
- Performance optimization for low-end devices
- Safe area and notch handling

---

## File Structure Reference

```
/format/        - DMAP binary format specification
/tools/         - Build and utility scripts
/data/          - Map tiles and output files
README.md       - Build pipeline overview
FORMAT.md       - Binary format specification
CLAUDE.md       - This file
```

## Related Documentation

- **FORMAT.md**: Complete DMAP format specification (v3-v8)
- **README.md**: Build pipeline and data sources
- Map data source: OpenStreetMap / OpenFreeMap
- Attribution required: © OpenStreetMap contributors (ODbL)

---

---

## Category 10: Release & Testing (10.1-10.4)

This category covers the final phases of preparation for releasing maps and the Drivemate app.

### 10.1 Packaging

**Status**: DONE

Map data is packaged and automatically published to GitHub releases (`maps-latest`):
- Build workflow in `.github/workflows/update-maps.yml`
- Automated tests verify DMAP file integrity
- Gzip compression for faster downloads
- Maps indexed and versioned in `data/published/index.json`
- Current published regions: Stockport (version 20261101_080013_pt)

---

### 10.2 Real Phone Testing

**Status**: IN PROGRESS

Purpose: Validate map data and app functionality on real mobile devices.

#### Testing Environment Setup

**Requirements**:
- Android or iOS device (or both for comprehensive testing)
- Drivemate app installed and built from source
- Map file downloaded from maps-latest release or sideloaded
- Location services enabled
- Sufficient storage space (~50-200MB for one region)

**Map Download Methods**:
1. **From Release**: Download `.dmap` file from GitHub release (`maps-latest`)
2. **Sideload**: Transfer file directly to device via USB/ADB (Android) or Xcode (iOS)
3. **In-App Download**: If app UI supports it (depends on app implementation)

#### Testing Checklist

**Map Loading & Integrity**
- [ ] App successfully loads DMAP file without crashes
- [ ] File format version is recognized (current: v8)
- [ ] Map boundaries display correctly (Stockport: -2.25,53.34 to -2.07,53.46)
- [ ] File size and checksum match release info
- [ ] No corrupted data errors in logs

**Visual Rendering**
- [ ] Road network displays correctly
- [ ] Road hierarchy (motorway, trunk, primary, etc.) is visible/distinguished
- [ ] Non-routed features render:
  - [ ] Rail lines
  - [ ] Underground/transit lines
  - [ ] Rivers and waterways
  - [ ] Footpaths and cycleways
  - [ ] Administrative boundaries
- [ ] Area features display:
  - [ ] Water bodies
  - [ ] Buildings
  - [ ] Parks and nature reserves
  - [ ] Green spaces
  - [ ] Urban/residential areas
- [ ] Labels appear correctly:
  - [ ] Place names
  - [ ] Road names
  - [ ] Water feature names
  - [ ] POI names
- [ ] Colors and styling match design system
- [ ] Zoom levels display appropriate detail

**Navigation & Routing**
- [ ] Route calculation works (if routing is implemented)
- [ ] Turn-by-turn instructions display correctly
- [ ] Road names appear in navigation UI
- [ ] Speed limits are shown (v7+ feature)
- [ ] Turn lane indicators display (v5+ feature)
- [ ] Restrictions respected in routing (v4+ feature)
- [ ] One-way streets are honored
- [ ] No-access roads are not routed through

**Performance**
- [ ] Map pans smoothly without lag
- [ ] Zoom operations are responsive
- [ ] No memory leaks during extended use (5+ minutes)
- [ ] Battery drain is acceptable
- [ ] App doesn't crash during normal use
- [ ] File load time is acceptable (<2 seconds on typical device)

**Edge Cases & Known Issues**
- [ ] Tile seams display without artifacts
- [ ] Duplicate areas near tile boundaries are not visible
- [ ] Road graph gaps (see README.md) don't affect routing
- [ ] Two-point loops are not present
- [ ] Stockport-specific issues (see README.md):
  - [ ] 195 connected road groups handle correctly
  - [ ] Service road access restrictions are respected

**Device-Specific Testing**
- [ ] Test on various screen sizes (small phone, large phone, tablet)
- [ ] Test in portrait and landscape modes
- [ ] Test with different device DPIs
- [ ] Test with low-end device resources
- [ ] Test with location services on/off
- [ ] Test with various orientation sensors

**Multiple Regions** (when London or other regions are enabled)
- [ ] Each region loads independently
- [ ] No cross-region data corruption
- [ ] Region switching doesn't cause crashes
- [ ] Index correctly lists all available regions

#### Testing Report Format

For each test run, document:
1. **Device Info**: Model, OS version, screen size, RAM, storage available
2. **Map Region**: Name, version, file size
3. **Test Date/Time**
4. **Results**: Pass/Fail for each checklist item
5. **Issues Found**: Description, reproducibility, severity
6. **Performance Metrics**:
   - File load time
   - Pan/zoom responsiveness
   - Memory usage (initial, max, final)
   - Battery drain rate
7. **Screenshots/Videos**: For UI issues or unusual behavior
8. **Tester Notes**: Anything else observed

#### Known Data Issues to Verify in Testing

From README.md and map building process:
- Road topology snapping tolerance: ~2m
- Crossings joined automatically (Stockport: 39,800 crossings)
- Road ends joined to roads (Stockport: 6,174 ends)
- Routing gaps exist in disconnected areas
- Tile seam deduplication is area-specific
- Some overlap (1-95%) near tile boundaries (829 pairs within 50m of seams)

---

### 10.3 App Identity

**Status**: Not started

Purpose: Define and implement app branding, versioning, and metadata.

**Scope**:
- App icon and launch screen design
- Version numbering scheme (coordinate with map versions)
- App metadata (name, description, category)
- Permissions and capabilities documentation
- Privacy policy and attribution (OpenStreetMap/ODbL)

---

### 10.4 Release

**Status**: Not started

Purpose: Deploy Drivemate app and map data to app stores.

**Scope**:
- App store submission (Google Play, Apple App Store)
- Map data release coordination
- Release notes and changelog
- Build signing and certificate management
- User communication and announcements

---

## Next Steps

1. **10.2 Real Phone Testing**: Set up testing environment and run through checklist
2. Collect test results and document any issues found
3. File GitHub issues for bugs discovered
4. Prepare for 10.3 App Identity work
5. Coordinate final release (10.4)
