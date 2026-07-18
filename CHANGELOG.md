## [Reliability and Radar Improvements] - 2026-07-18

- Add a red progress indicator to radar animations so loop restarts are obvious.
- Add warning details and distinguish fresh, stale, and unavailable weather data.
- Preserve real zero readings while marking missing weather values as unavailable.
- Bound and prune radar images and animations, validate cached data, and write cache files atomically.
- Make radar favorites and default locations update immediately in the active view.
- Validate and repair saved locations, radar favorites, and frame-count settings.
- Add request cancellation, visible action/search errors, broader automated tests, and continuous integration checks.

## [Initial Release] - 2026-05-17

- Add Australian Bureau of Meteorology forecasts, warnings, current weather, and radar loops.
- Add saved weather locations, quick weather summary metadata, and menu bar current weather.
- Add Bureau attribution, personal non-commercial use notes, and conservative caching.
