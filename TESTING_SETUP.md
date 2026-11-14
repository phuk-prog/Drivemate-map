# Testing Environment Setup

Complete this checklist before starting real phone testing.

---

## Pre-Testing Setup

### Step 1: Get the Map File

Choose one method:

**Method A: Download from GitHub Release**
```bash
# Visit and download stockport.dmap from:
# https://github.com/phuk-prog/Drivemate-map/releases/tag/maps-latest

# Verify file integrity (check size matches release info)
ls -lh stockport.dmap
# Should be ~12.2 MB for Stockport
```

**Method B: Build Locally**
```bash
# From this repository directory:
node tools/fetch-tiles.mjs --bbox=-2.25,53.34,-2.07,53.46 --zoom=14
node tools/build-area.mjs --name=stockport --bbox=-2.25,53.34,-2.07,53.46 --zoom=14

# Verify the map
node tools/test-map.mjs

# Result: data/out/stockport.dmap
```

### Step 2: Get the Drivemate App

**For Android**:
1. Clone/checkout the Drivemate app repository
2. Build APK: `./gradlew assembleDebug`
3. Or download from Play Store if available

**For iOS**:
1. Clone/checkout the Drivemate app repository
2. Open in Xcode: `open Drivemate.xcodeproj`
3. Or download from App Store if available

---

## Android Testing Setup

### Prerequisites Checklist

- [ ] Android device (8+ Android version recommended)
- [ ] USB cable
- [ ] Computer with ADB installed
- [ ] 500MB+ free storage on device

### Install ADB Tools

**On Linux/Mac**:
```bash
# Using Android SDK
# https://developer.android.com/studio/command-line/adb

# Or using package manager
brew install android-platform-tools  # macOS
sudo apt-get install android-tools-adb  # Ubuntu/Debian
```

**On Windows**:
- Download Android SDK Platform Tools
- Add to PATH

### Enable Developer Mode on Device

1. Open Settings
2. Go to About Phone
3. Find "Build Number"
4. Tap 7 times (rapidly)
5. Back to Settings → Developer Options
6. Enable "USB Debugging"

### Verify ADB Connection

```bash
# Connect device via USB
adb devices
# Should list your device with "device" status

# Test connection
adb shell echo "hello"
# Should print "hello"
```

### Transfer Map File to Device

**Option 1: To Downloads folder**
```bash
adb push stockport.dmap /sdcard/Download/
```

**Option 2: To app directory (if app is installed)**
```bash
# First, get the app package name
adb shell pm list packages | grep -i drivemate

# Then push to app's files directory
adb push stockport.dmap /sdcard/Android/data/com.phuk.drivemate/files/
```

**Option 3: Via Android File Transfer**
1. Connect device via USB
2. Enable file transfer mode
3. Drag file to device storage

### Verify File Transfer

```bash
# Check if file exists on device
adb shell ls -lh /sdcard/Download/stockport.dmap
# Should show ~12.2 MB file

# Alternative: check app directory
adb shell ls -lh /sdcard/Android/data/com.phuk.drivemate/files/
```

### Setup Logging

```bash
# Clear previous logs
adb logcat -c

# Start capturing logs to file (in background)
adb logcat > android_test_$(date +%Y%m%d_%H%M%S).log &

# Or monitor real-time
adb logcat | grep -i "drivemate\|dmap\|error"
```

### Android Checklist

- [ ] Device connected via ADB
- [ ] USB debugging enabled
- [ ] 500MB+ free storage
- [ ] Map file transferred to device
- [ ] Drivemate app installed
- [ ] Developer console accessible
- [ ] Logging set up

---

## iOS Testing Setup

### Prerequisites Checklist

- [ ] iPhone or iPad (iOS 14+ recommended)
- [ ] Mac with Xcode installed
- [ ] USB-C or Lightning cable
- [ ] 500MB+ free storage on device

### Install Xcode

```bash
# Download from App Store
xcode-select --install  # Install command line tools

# Or download full Xcode from:
# https://developer.apple.com/download/
```

### Enable Developer Mode on Device

1. Connect device to Mac
2. Open Xcode
3. Window → Devices and Simulators
4. Select your device
5. "Trust" the computer when prompted

### Transfer Map File to Device

**Method 1: Via Xcode (File Sharing)**
1. Xcode → Window → Devices and Simulators
2. Select your device
3. Select the Drivemate app
4. Drag `stockport.dmap` into "Documents" section

**Method 2: Via Files App**
1. On device, open Files app
2. On Mac, place file in iCloud Drive
3. Device Files app → iCloud Drive
4. Tap file to open with Drivemate

**Method 3: Via AirDrop (if on same network)**
1. On Mac: Finder → AirDrop → select device
2. Drag file to device
3. Device receives file → open with Drivemate

### Build and Deploy App from Xcode

```bash
# Open project
cd /path/to/Drivemate
open Drivemate.xcodeproj

# In Xcode:
# 1. Select your device from top toolbar
# 2. Product → Build For Running
# 3. Product → Run (or Cmd+R)
```

### Setup Console Logging

In Xcode:
1. Product → Scheme → Edit Scheme
2. Run → Pre-actions
3. Post-actions: Add script to capture logs
4. Or: View → Debug Area → Console to see real-time logs

### iOS Checklist

- [ ] Device connected to Mac via USB
- [ ] Trust dialog dismissed on device
- [ ] Xcode opened with Drivemate project
- [ ] 500MB+ free storage on device
- [ ] Map file transferred to device
- [ ] App can be built in Xcode
- [ ] Console logging accessible

---

## Pre-Test Device Checks

### Verify Device Storage

**Android**:
```bash
adb shell df -h
# Look for /sdcard: should have 500MB+ free
```

**iOS**:
Settings → General → iPhone/iPad Storage

**Target**: At least 500MB free

### Verify Location Services

**Android**:
Settings → Location → On (toggle enabled)

**iOS**:
Settings → Privacy → Location Services → On

**For Testing**: Enable for more realistic navigation scenarios

### Clear App Cache

**Android**:
```bash
adb shell pm clear com.phuk.drivemate
```

**iOS**:
Settings → General → iPhone Storage → Drivemate → Offload App → Reinstall App

**Why**: Ensures clean state for testing

### Note Device Specs

Before testing, record:
- Device model: _______________
- OS version: _______________
- Screen size: _______________
- RAM: _______________
- Storage available: _______________

---

## Ready to Test?

Run through this final checklist:

### Environment
- [ ] Device connected and accessible
- [ ] ADB/Xcode working properly
- [ ] Console logging operational
- [ ] Device has clean app state

### Map Files
- [ ] Map file downloaded/built successfully
- [ ] File size verified correct
- [ ] File transferred to device
- [ ] File accessible from app

### App
- [ ] Latest version installed
- [ ] Can be launched without crashes
- [ ] Can access device files
- [ ] Location services working

### Testing Documentation
- [ ] TESTING_CHECKLIST.md printed or available
- [ ] PHONE_TESTING_GUIDE.md reviewed
- [ ] Understanding of test phases
- [ ] Ready to document results

---

## If Something Goes Wrong

### ADB Issues

**"No devices found"**:
```bash
# Reconnect device
adb kill-server
adb start-server
adb devices
```

**Permission denied**:
```bash
# Add udev rules on Linux
# Or try: adb kill-server && sudo adb start-server
```

### Xcode Issues

**Build fails**:
- Clean build folder: Cmd+Shift+K
- Delete derived data: ~/Library/Developer/Xcode/DerivedData

**Device not listed**:
- Disconnect and reconnect cable
- Restart Xcode
- Restart device

### Map File Issues

**File won't load**:
- Verify file not corrupted: `file stockport.dmap | head -c 4` should be "DMAP"
- Check file permissions: `adb shell chmod 644 /path/to/file`
- Try re-transferring file

### Device Storage Issues

**Not enough space**:
```bash
# Android: clear cache
adb shell pm trim-caches 1000000000

# iOS: delete other apps temporarily
```

---

## Next: Start Testing

Once setup is complete, follow the procedures in:
- **TESTING_CHECKLIST.md** - Quick reference during testing
- **PHONE_TESTING_GUIDE.md** - Detailed test procedures
- **CLAUDE.md** - Technical requirements and acceptance criteria

---

**Setup Time Estimate**:
- First-time Android setup: 30-45 minutes
- First-time iOS setup: 45-60 minutes
- Subsequent tests: 5-10 minutes setup

**Need Help?**:
See troubleshooting section in PHONE_TESTING_GUIDE.md or file an issue on GitHub.

---

**Last Updated**: 2026-11-14
