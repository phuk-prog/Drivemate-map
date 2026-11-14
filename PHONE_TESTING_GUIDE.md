# Drivemate Map - Real Phone Testing Guide

## Overview

This guide provides step-by-step instructions for testing Drivemate map files on real mobile devices. Real phone testing validates that the DMAP files work correctly in the actual app and on real hardware.

## Prerequisites

### For Android

- Android device running Android 10+ recommended
- Android Debug Bridge (ADB) installed on computer
- USB cable and USB debugging enabled on device
- Drivemate app APK built and ready to sideload, OR
- Drivemate app already installed (get from app store or build from source)

### For iOS

- iOS device running iOS 14+ recommended
- Mac with Xcode installed
- Drivemate app built and ready to deploy, OR
- Drivemate app already installed
- Development provisioning profile set up

### General Requirements

- Latest DMAP file from `https://github.com/phuk-prog/Drivemate-map/releases/tag/maps-latest`
- Device has at least 500MB free storage
- Location services available (for navigation testing)
- WiFi or mobile data for downloading maps (initial setup)

## Getting the Map File

### Option 1: Download from GitHub Release

1. Visit: https://github.com/phuk-prog/Drivemate-map/releases/tag/maps-latest
2. Download the desired `.dmap` file (e.g., `stockport.dmap`)
3. Keep note of the file size and version info from the release page

### Option 2: Build Locally

From your development environment:

```bash
# Build the Stockport region
node tools/fetch-tiles.mjs --bbox=-2.25,53.34,-2.07,53.46 --zoom=14
node tools/build-area.mjs --name=stockport --bbox=-2.25,53.34,-2.07,53.46 --zoom=14

# Verify the build
node tools/test-map.mjs

# Output: data/out/stockport.dmap (size ~12MB for Stockport)
```

## Installing on Android

### Method 1: Sideload via ADB

1. **Connect device to computer via USB**
   ```bash
   adb devices
   # Should list your device
   ```

2. **Transfer DMAP file to device**
   ```bash
   # Option A: To Downloads folder
   adb push stockport.dmap /sdcard/Download/
   
   # Option B: To app's specific directory (if app is installed)
   adb shell pm list packages | grep drivemate
   adb push stockport.dmap /sdcard/Android/data/com.phuk.drivemate/files/
   ```

3. **Open app and load map**
   - Open Drivemate app
   - Go to Map Management or Settings
   - Select "Load Map" or "Import Map"
   - Choose the `stockport.dmap` file

### Method 2: Via Android File Transfer

1. Connect device via USB
2. Enable file transfer mode
3. Copy map file to `Documents/Drivemate/` or similar (depends on app)
4. In app, import from that location

## Installing on iOS

### Method 1: Via Xcode

1. Connect device to Mac via USB
2. Open Xcode project for Drivemate
3. In Xcode:
   - Select device from top toolbar
   - Click "Run" to build and deploy app
4. In app, import map file from Files app or document picker

### Method 2: Via File Sharing

1. Connect device to Mac
2. In Xcode: Window → Devices and Simulators
3. Select device, then app
4. Drag DMAP file into "Documents" section
5. In app, access from Files/Documents

### Method 3: Via Air Drop or iCloud

1. On Mac: Place DMAP file in iCloud Drive
2. On iOS device: Open Files app
3. Navigate to iCloud Drive
4. Open file with Drivemate app

## Pre-Testing Checklist

Before running tests, verify:

- [ ] Map file is not corrupted: `ls -lh stockport.dmap` shows reasonable size
- [ ] Device has sufficient storage: At least 500MB free
- [ ] Device date/time is correct (affects OSM data validation)
- [ ] Drivemate app is running latest version
- [ ] Location services are enabled
- [ ] Developer console/logging is enabled for debugging

## Testing Procedure

### Part 1: File Loading (5 minutes)

1. **Launch Drivemate app**
2. **Navigate to map import/load screen**
3. **Select the DMAP file**
4. **Observe load time and memory usage**
   - Should load in < 2 seconds on typical device
   - Monitor app memory in system settings
5. **Check for error messages in console or toast notifications**
   - File format errors
   - Corruption messages
   - Size warnings

**Expected Result**: Map loads without crashes or errors

**Logging**: 
```
For Android (ADB):
adb logcat | grep -i "drivemate\|dmap"

For iOS (Xcode):
View logs in Xcode Console during app execution
```

### Part 2: Visual Rendering (10 minutes)

**Test in different zoom levels:**

#### Zoom Level 5-8 (Continent/Region view - if supported)
- [ ] Overview of Stockport region visible
- [ ] Boundaries and outlines correct
- [ ] No obvious visual artifacts

#### Zoom Level 10-12 (City view)
- [ ] Districts and neighborhoods distinguishable
- [ ] Major roads visible (motorways, trunk roads)
- [ ] Parks and water bodies show as colored areas
- [ ] Administrative boundaries visible

#### Zoom Level 14-16 (Street view)
- [ ] Individual roads clearly visible
- [ ] Street-level detail accurate
- [ ] Building outlines visible
- [ ] Pedestrian paths and footways visible

#### Zoom Level 18-20 (Building detail - if rendering)
- [ ] Fine details visible
- [ ] Road surface features visible
- [ ] Individual building features clear

**Check each feature type:**

```
Road Network:
- [ ] Motorways displayed (color: red/orange)
- [ ] Trunk roads displayed (color: red)
- [ ] Primary roads displayed (color: orange)
- [ ] Secondary roads (color: yellow)
- [ ] Tertiary roads (color: light yellow)
- [ ] Minor roads (color: white)
- [ ] Service roads visible
- [ ] Tracks/rough roads visible
- [ ] One-way streets indicated

Non-Routed Features:
- [ ] Rail lines visible (solid line)
- [ ] Underground/Metro lines visible (dotted line)
- [ ] Ferry routes visible
- [ ] Footpaths/Cycleways visible
- [ ] Rivers and waterways visible

Area Features:
- [ ] Water bodies (lakes, ponds) - blue polygons
- [ ] Buildings - gray/beige polygons
- [ ] Parks and green spaces - green polygons
- [ ] Woods - darker green
- [ ] Grass and fields - light green
- [ ] Urban areas - light gray
- [ ] Industrial areas - different shade

Labels:
- [ ] City/town names appear (e.g., "Stockport")
- [ ] District names visible
- [ ] Major road names visible
- [ ] Water feature names visible
- [ ] POI names appear (if included)
- [ ] No overlapping or illegible labels
```

**Expected Result**: All feature types render correctly with appropriate styling

### Part 3: Interaction Testing (10 minutes)

1. **Panning**
   - Drag map in all directions (up, down, left, right, diagonal)
   - Observe smoothness and responsiveness
   - Check for stuttering or freezing
   - Verify map scrolls smoothly at all zoom levels

2. **Zooming**
   - Pinch to zoom in/out on touch devices
   - Use zoom buttons/keyboard if available
   - Zoom from level 5 to 20 progressively
   - Check responsiveness at each level

3. **Rotation**
   - If supported: rotate map with gesture
   - Check for visual distortions
   - Verify labels rotate correctly

4. **Panning at Different Zoom Levels**
   - At zoom 10: pan across multiple districts
   - At zoom 14: pan across city blocks
   - At zoom 18: pan through neighborhood
   - Verify seamless transitions

**Expected Result**: All interactions are smooth and responsive

### Part 4: Navigation Testing (if implemented)

1. **Set a Start Point**
   - Long-tap on map or use current location
   - Verify point appears on map

2. **Set a Destination**
   - Search for a location or tap on map
   - Destination marker appears

3. **Calculate Route**
   - Tap "Navigate" or similar button
   - Route should calculate within 1-2 seconds
   - Route line appears on map

4. **Verify Route**
   - Route follows roads (not through buildings)
   - Route avoids no-access roads
   - Route respects one-way directions
   - Route uses appropriate road classes

5. **Test Turn-by-Turn Instructions**
   - Instructions display in order
   - Road names match map data
   - Turn arrows point correctly
   - Distance and time estimates seem reasonable

6. **Test Rerouting**
   - If off-route: verify reroute occurs
   - New route calculates quickly
   - No crashes or errors

**Expected Result**: Navigation functions correctly with real-time updates

### Part 5: Performance Monitoring (Continuous)

Monitor throughout all testing:

**Memory Usage**:
- [ ] Initial memory < 150MB
- [ ] Peak memory < 500MB during panning
- [ ] Memory stable (no continuous growth)
- [ ] No OutOfMemory errors

**Battery Usage**:
- [ ] Monitor battery drain over 15 minutes
- [ ] Should be similar to other navigation apps
- [ ] No excessive CPU/GPU usage

**Responsiveness**:
- [ ] App responds to input within 100ms
- [ ] No frozen/laggy UI
- [ ] 60 FPS rendering maintained (where applicable)

**Logging/Errors**:
- [ ] No crash reports
- [ ] No persistent warnings in logs
- [ ] No data corruption indicators

### Part 6: Device-Specific Testing

**Different Screen Sizes**:
- Test on at least: small phone, large phone, tablet
- Verify UI adapts appropriately
- Check that controls are easily tappable

**Orientation Changes**:
- Rotate device to landscape while viewing map
- Rotate back to portrait
- Verify map state is preserved
- Verify UI adapts correctly

**Low Battery Mode** (if available):
- Enable low battery mode
- Verify app still functions
- Check for performance degradation

**Location Services**:
- With GPS on: verify location dot moves as you walk
- With GPS off: verify manual location works
- Test with location disabled entirely

## Test Results Documentation

### File Template

Create a new file `TEST_RESULTS_<DATE>_<DEVICE>.md`:

```markdown
# Test Results

- **Date**: 2026-11-14
- **Tester**: [Your Name]
- **Device**: Samsung Galaxy S21 / iPhone 13 / etc.
- **OS Version**: Android 13 / iOS 17
- **RAM**: 8GB / 6GB
- **Storage Available**: 128GB free

## Map Information

- **File**: stockport.dmap
- **Version**: 20261101_080013_pt
- **File Size**: 12.2 MB
- **Regions**: Stockport (2.25°W-2.07°W, 53.34°N-53.46°N)

## Testing Summary

- **Start Time**: HH:MM
- **End Time**: HH:MM
- **Total Issues Found**: N

## Test Results

### Part 1: File Loading
- Load Time: X seconds
- Load Error: Yes/No
- Status: PASS/FAIL

### Part 2: Visual Rendering
- Zoom 5-8: PASS/FAIL (notes)
- Zoom 10-12: PASS/FAIL (notes)
- Zoom 14-16: PASS/FAIL (notes)
- Zoom 18-20: PASS/FAIL (notes)
- Roads: PASS/FAIL
- Lines: PASS/FAIL
- Polygons: PASS/FAIL
- Labels: PASS/FAIL

### Part 3: Interactions
- Panning: PASS/FAIL (notes)
- Zooming: PASS/FAIL (notes)
- Rotation: PASS/FAIL (notes)

### Part 4: Navigation
- Route Calculation: PASS/FAIL (X ms)
- Route Accuracy: PASS/FAIL
- Turn Instructions: PASS/FAIL
- Rerouting: PASS/FAIL

### Part 5: Performance
- Initial Memory: X MB
- Peak Memory: X MB
- Battery Drain: X% / 15 min
- Responsiveness: PASS/FAIL
- Crashes: 0

### Part 6: Device-Specific
- Screen Adaptability: PASS/FAIL
- Orientation: PASS/FAIL
- Low Battery Mode: PASS/FAIL
- Location Services: PASS/FAIL

## Issues Found

### Issue #1: [Title]
- **Severity**: High/Medium/Low
- **Reproducibility**: Always/Sometimes/Never
- **Steps**: 
  1. ...
  2. ...
- **Expected**: ...
- **Actual**: ...
- **Screenshots**: [Attach if applicable]
- **Logs**: 
  ```
  [Relevant log entries]
  ```

## Notes

[Any observations, suggestions, or notes about the testing experience]

## Recommendation

APPROVED / NEEDS FIXES / BLOCKED

[Reasoning and next steps]
```

## Troubleshooting

### App Crashes on Map Load

**Symptoms**: App crashes or force-closes when loading DMAP file

**Solutions**:
1. Verify file is not corrupted: Check file size matches release info
2. Ensure app version is current: Update from store or rebuild
3. Clear app cache: Settings → Apps → Drivemate → Storage → Clear Cache
4. Free up device memory: Close other apps
5. Try with a different DMAP file if available

### Map Not Rendering

**Symptoms**: Map appears blank or shows only partial data

**Solutions**:
1. Verify map file location is correct
2. Check file permissions (should be readable)
3. Zoom in/out to trigger render
4. Restart app completely (force stop and reopen)
5. Verify screen is not in screen saver mode

### Performance Issues / Lag

**Symptoms**: App stutters, is slow to respond, or has low FPS

**Solutions**:
1. Close background apps to free RAM
2. Reduce zoom level (simpler rendering)
3. Disable any real-time tracking if enabled
4. Restart device
5. Update graphics drivers (if applicable)
6. Try on a different device if available

### Crashes During Navigation

**Symptoms**: App crashes during route calculation or navigation

**Solutions**:
1. Verify start and destination are within map bounds
2. Try with different start/destination points
3. Check for one-way restrictions blocking route
4. Look for missing road connections in map data
5. File GitHub issue with route details for analysis

### File Won't Import

**Symptoms**: App doesn't recognize or won't import the DMAP file

**Solutions**:
1. Verify filename ends in `.dmap`
2. Check file location is accessible by app
3. Verify file permissions allow reading
4. Try transferring file again (file may be corrupted in transfer)
5. Verify file matches expected version in app

## Reporting Issues

When you find a bug or issue:

1. Document the issue using the template in "Test Results Documentation"
2. Collect relevant information:
   - Device details (model, OS version, RAM)
   - Exact steps to reproduce
   - Screenshots or video if visual
   - Log output from adb/Xcode console
3. Create GitHub Issue at: https://github.com/phuk-prog/Drivemate-map/issues
   - Title: Clear, concise description
   - Description: Use the template above
   - Labels: bug, phone-testing, android/ios
   - Attach: Screenshots, log files

## Performance Baseline

For reference, here are expected performance metrics on typical devices:

| Metric | Typical | Good | Excellent |
|--------|---------|------|-----------|
| Load Time | < 3s | < 2s | < 1s |
| Initial Memory | 100-150MB | < 100MB | < 80MB |
| Peak Memory | 400-500MB | < 400MB | < 300MB |
| Pan Responsiveness | 50-100ms | 16-50ms | < 16ms |
| Zoom Responsiveness | 100-200ms | 50-100ms | < 50ms |
| Battery Drain | 10-15% / 30min | < 10% / 30min | < 5% / 30min |

## Success Criteria for Phase 10.2

- [ ] Tested on minimum 2 different Android devices
- [ ] Tested on minimum 1 iOS device (if iOS app exists)
- [ ] At least one large screen device (tablet or large phone)
- [ ] All critical checklist items PASS
- [ ] No crashes during 20+ minute continuous use
- [ ] Navigation works correctly if implemented
- [ ] No blocking issues filed (or all blocking issues have workarounds)
- [ ] Performance metrics within acceptable range

## Next Steps After Testing

1. Compile all test results
2. Categorize any issues by severity
3. File GitHub issues for bugs found
4. Plan fixes for critical issues
5. Proceed to Category 10.3: App Identity

---

**Last Updated**: 2026-11-14
