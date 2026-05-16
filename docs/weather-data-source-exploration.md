# Weather Data Source Exploration

## Context

The current implementation fetches location search, daily forecasts, hourly
forecasts, observations, and warnings from:

```text
https://api.weather.bom.gov.au/v1/locations
```

A live response from that service includes metadata stating that the API is
owned by the Bureau of Meteorology and must not be used, copied, or shared.
That makes it unsuitable for a public Raycast Store extension unless written
permission is obtained.

## Candidate Sources

### 1. Bureau Anonymous FTP / Web Data Products

The Bureau documents automated data products under "Weather Data Services".
These are exposed by web and Anonymous FTP, are free to access, and are not for
commercial use. The documentation also says the Bureau does not guarantee FTP
availability, and users needing support or service continuity should use
Registered User Services.

Relevant documented products:

- `/fwo`: forecast, warning, observation, rainfall, river height, and daily OCF
  products.
- Observations: 72-hour station products are available in XML, AXF, and JSON.
- Warnings: current warnings are documented as available via Anonymous FTP and
  RSS/state warning pages.
- Text forecasts: city, town, district, coastal, state, and territory forecast
  products are available in TXT, HTML, PDF, and XML variants depending on
  product.

Pros:

- Officially documented for automated data access.
- More defensible than the web-app JSON API.
- HTTP access to the same product files may avoid needing an FTP client inside
  the Raycast extension.

Cons:

- Data is product/code oriented, not geohash oriented.
- Rebuilding the current UX requires mapping saved locations to forecast
  product areas/stations.
- Hourly forecast parity is unlikely from text forecast products alone.
- Anonymous products are still personal/internal-use only unless registered
  licensing allows more.

### 2. Registered User Services

Registered User Services are the Bureau-recommended path for service continuity,
support, and publishing Bureau data.

Pros:

- Best legal/compliance posture for a public extension.
- More stable support channel.

Cons:

- Requires user or maintainer registration/licensing.
- Not ideal for a simple personal Raycast extension unless the user already has
  credentials and redistribution rights.

### 3. Keep Current API Behind a Personal-Use Warning

This is acceptable only for private/local use after the user understands the
restriction. It should not be submitted to the public Raycast Store.

Pros:

- Preserves current UX and location-level detail.
- Already implemented and validated by build/lint/tests.

Cons:

- API metadata explicitly says not to use/copy/share.
- High risk for public distribution.

## Recommendation

For a public or shared extension, replace the API with documented Bureau data
products where feasible:

1. Build a `BomDataSource` interface around search, current conditions, daily
   forecast, hourly forecast, and warnings.
2. Add an FTP/web-product-backed implementation for observations and warnings
   first, since those are explicitly documented.
3. Add forecast support from XML/text forecast products with a reduced feature
   set if hourly/geohash parity is unavailable.
4. Keep the existing API implementation only as a private/local provider, gated
   by clear documentation and not enabled for public builds.

If the goal remains a personal unpublished extension, the current provider can
stay while the branch prototypes the documented-product provider.

## Sources Checked

- Bureau Weather Data Services:
  https://www.bom.gov.au/catalogue/data-feeds.shtml
- Bureau Anonymous FTP Service user guide:
  https://www.bom.gov.au/catalogue/Bureau_of_Meteorology_Anonymous_FTP_Service_user_guide.pdf
- Bureau Text Forecasts user guide:
  https://www.bom.gov.au/catalogue/Bureau_of_Meteorology_text_forecasts_user_guide.pdf
- Bureau FTP public products:
  https://www.bom.gov.au/catalogue/anon-ftp.shtml
