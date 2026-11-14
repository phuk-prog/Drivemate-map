# Quick Phone Testing Checklist

**Date**: ____________  
**Tester**: ____________  
**Device**: ____________ OS: ____  
**Map**: ____________ Version: ____________

---

## SETUP (Do once)

- [ ] Device has 500MB+ free storage
- [ ] Map file downloaded/sideloaded
- [ ] Drivemate app installed and up-to-date
- [ ] Location services enabled
- [ ] Developer console accessible

---

## PART 1: LOADING (5 min)

| Check | Pass | Fail | Notes |
|-------|------|------|-------|
| File loads without crash | ☐ | ☐ | |
| Load time < 2 seconds | ☐ | ☐ | Time: ___s |
| No error messages | ☐ | ☐ | |
| Memory usage < 150MB initial | ☐ | ☐ | Actual: ___MB |
| Correct file size shown | ☐ | ☐ | |

---

## PART 2: VISUAL RENDERING (10 min)

### Zoom Levels
| Level | Roads | Features | Labels | Status |
|-------|-------|----------|--------|--------|
| 5-8 | ☐ | ☐ | ☐ | ☐ PASS |
| 10-12 | ☐ | ☐ | ☐ | ☐ PASS |
| 14-16 | ☐ | ☐ | ☐ | ☐ PASS |
| 18-20 | ☐ | ☐ | ☐ | ☐ PASS |

### Road Classes
- [ ] Motorways visible
- [ ] Trunk roads visible
- [ ] Primary roads visible
- [ ] Secondary roads visible
- [ ] Minor roads visible
- [ ] One-way streets marked

### Features
- [ ] Rail lines visible
- [ ] Underground lines visible
- [ ] Rivers/waterways visible
- [ ] Footpaths visible
- [ ] Water areas (blue)
- [ ] Buildings visible
- [ ] Parks (green)
- [ ] Urban areas
- [ ] Industrial areas

### Labels
- [ ] City names visible
- [ ] Road names appear
- [ ] Water names visible
- [ ] No overlapping text
- [ ] Text readable

---

## PART 3: INTERACTIONS (10 min)

| Action | Smooth | Responsive | No Lag | Status |
|--------|--------|------------|--------|--------|
| Pan left/right | ☐ | ☐ | ☐ | ☐ PASS |
| Pan up/down | ☐ | ☐ | ☐ | ☐ PASS |
| Diagonal pan | ☐ | ☐ | ☐ | ☐ PASS |
| Pinch zoom in | ☐ | ☐ | ☐ | ☐ PASS |
| Pinch zoom out | ☐ | ☐ | ☐ | ☐ PASS |
| Rotate map* | ☐ | ☐ | ☐ | ☐ PASS |

*If supported

---

## PART 4: NAVIGATION (10 min)

| Feature | Works | Correct | Notes |
|---------|-------|---------|-------|
| Route calculation | ☐ | ☐ | Time: ___ms |
| Route follows roads | ☐ | ☐ | |
| Respects one-way | ☐ | ☐ | |
| Avoids no-access | ☐ | ☐ | |
| Turn instructions | ☐ | ☐ | |
| Road names shown | ☐ | ☐ | |
| Rerouting works | ☐ | ☐ | |

---

## PART 5: PERFORMANCE (Monitor continuously)

| Metric | Initial | Peak | Status |
|--------|---------|------|--------|
| Memory (MB) | ___ | ___ | ☐ OK |
| Battery % drop / 15min | | ___ % | ☐ OK |
| Crashes | | 0 | ☐ OK |
| Errors in log | | 0 | ☐ OK |

---

## PART 6: DEVICE-SPECIFIC (5 min)

- [ ] Works in portrait orientation
- [ ] Works in landscape orientation
- [ ] UI readable on screen size
- [ ] Touch targets easily tappable
- [ ] Rotate device: map preserved
- [ ] No layout issues
- [ ] All text visible

---

## CRITICAL ISSUES

| Issue | Yes | No | Severity |
|-------|-----|--|-|
| App crashes | ☐ | ☐ | CRITICAL |
| Map won't load | ☐ | ☐ | CRITICAL |
| Map corrupted | ☐ | ☐ | CRITICAL |
| Severe lag/freeze | ☐ | ☐ | HIGH |
| Wrong data displayed | ☐ | ☐ | HIGH |
| Crash on navigation | ☐ | ☐ | HIGH |

---

## OVERALL RESULT

- **Testing Duration**: _______ min
- **Total Issues**: _______
- **Critical Issues**: _______
- **Overall Status**: ☐ PASS ☐ NEEDS FIXES ☐ BLOCKED

---

## ISSUES FOUND

1. **Issue**: _________________________________
   - **Steps**: _______________________________
   - **Severity**: ☐ Critical ☐ High ☐ Medium ☐ Low

2. **Issue**: _________________________________
   - **Steps**: _______________________________
   - **Severity**: ☐ Critical ☐ High ☐ Medium ☐ Low

3. **Issue**: _________________________________
   - **Steps**: _______________________________
   - **Severity**: ☐ Critical ☐ High ☐ Medium ☐ Low

---

## RECOMMENDATIONS

☐ APPROVED for next phase
☐ Approved with notes
☐ Needs fixes - file issues
☐ Blocked - critical issues

---

**Tester Signature**: ________________ **Date**: ________
