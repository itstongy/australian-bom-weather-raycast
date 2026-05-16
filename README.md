# Australian BOM Weather for Raycast

Personal Raycast extension for Australian Bureau of Meteorology forecasts, warnings, and radar loops.

This extension is for Australian weather data only. It does not provide NOAA/NWS, Met Office, Environment Canada, or other international weather radar.

## Attribution and Use

Weather data is sourced from the Bureau of Meteorology. © Bureau of Meteorology.

This extension is intended for personal, non-commercial use. Bureau information is subject to the Bureau's copyright notice, disclaimer, and data service terms. Some Bureau products, including radar images and specialised data, may require a data licence agreement for reproduction, publication, redistribution, or commercial use.

Relevant Bureau pages:

- Copyright: https://www.bom.gov.au/copyright
- Disclaimer: https://www.bom.gov.au/disclaimer
- Data services: https://www.bom.gov.au/resources/data-services
- Brand and attribution policy: https://www.bom.gov.au/data-access/brand-trademark-display-policy.shtml

## Cache Policy

The extension caches data to avoid repeated requests and to stay aligned with normal Bureau update frequencies:

- Radar site/product catalogue: 7 days
- Radar frame index: 3 minutes
- Rendered radar GIFs: 3 minutes
- Observations: 10 minutes
- Hourly forecast: 30 minutes
- Daily forecast: 1 hour
- Warnings: 30 minutes

These cache windows are intentionally conservative for an interactive personal-use extension. They should be revisited before any public or commercial distribution.
