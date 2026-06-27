# Radar Data Source Exploration

## Context

The current radar implementation uses two source types:

- It scrapes legacy radar site table pages to discover products.
- It scrapes each radar loop HTML page for `theImageNames` to discover frame
  URLs, then downloads the PNG frames and overlay transparencies.

This works today, but the HTML scraping is the weakest part of the radar
implementation from a maintenance and policy perspective.

## Officially Documented Radar Products

The Bureau documents radar images as Anonymous FTP products:

- Radar images are product code `IDR` under `/radar`.
- Static transparencies/overlays are under `/radar_transparencies`.
- Radar images are issued every five minutes.
- The service is free for personal/internal use but not commercial use.
- Anonymous FTP has no availability guarantee.

Live checks confirm the documented FTP source contains frame listings such as:

```text
ftp://ftp.bom.gov.au/anon/gen/radar/IDR662.T.202605162134.png
```

The same PNG frame is also available over the Bureau web path currently used by
the app:

```text
https://reg.bom.gov.au/radar/IDR662.T.202605162104.png
```

Overlay files are present in the documented transparency directory:

```text
ftp://ftp.bom.gov.au/anon/gen/radar_transparencies/IDR663.background.png
ftp://ftp.bom.gov.au/anon/gen/radar_transparencies/IDR663.locations.png
```

## Options

### 1. Replace Loop-Page Scraping With FTP Directory Listings

Use the documented FTP `/radar` directory listing to build frame indexes by
product id. This removes the most fragile HTML dependency.

Pros:

- Uses the documented automated data product location.
- Product timestamps are available directly in filenames.
- Keeps current GIF rendering code largely unchanged.

Cons:

- Requires FTP support. Node's built-in `https` module is not enough, so the
  extension would need either a small FTP client dependency or a web-accessible
  equivalent directory listing.
- FTP directory listing parsing is still text parsing, but it is parsing the
  documented product service rather than website UI HTML.
- Public distribution still needs personal/non-commercial constraints or
  registered-user licensing.

### 2. Keep Web PNG Downloads, Replace Only Frame Discovery

Use FTP only to list current frame filenames, then download frames from:

```text
https://reg.bom.gov.au/radar/<filename>
```

Pros:

- Avoids FTP binary downloads inside Raycast.
- Uses the same reliable web image path already proven by the current code.
- Keeps lower implementation risk.

Cons:

- Still depends on `reg.bom.gov.au` web hosting for the actual frames.
- Needs confirmation that using FTP listings plus web-hosted PNGs is acceptable
  for the target distribution model.

### 3. Keep Current Implementation for Private Use

For a private local extension, the current approach is pragmatic and functional.
The code already caches the catalogue and frame index to reduce requests.

Pros:

- Already works.
- No new FTP dependency.
- Best UX right now because it discovers products from Bureau site tables.

Cons:

- HTML page structure changes can break discovery.
- Not a strong posture for a public store review.

## Recommendation

For the next implementation branch, prototype option 2:

1. Add a radar frame provider interface.
2. Implement an FTP-listing provider that lists `/anon/gen/radar`, filters by
   product id, sorts by timestamp, and returns the latest frames.
3. Continue downloading PNGs from `https://reg.bom.gov.au/radar/<filename>` so
   Raycast only needs HTTP(S) for image fetches.
4. Leave catalogue discovery unchanged initially, then replace the site table
   scraping with a static curated catalogue or an explicit product list if a
   documented source for site metadata is found.

If FTP support inside the extension proves unacceptable, keep the current radar
implementation for private use and document that it is not ready for public
store submission.

## Sources Checked

- Bureau Weather Data Services:
  https://www.bom.gov.au/catalogue/data-feeds.shtml
- Bureau Anonymous FTP Service user guide:
  https://www.bom.gov.au/catalogue/Bureau_of_Meteorology_Anonymous_FTP_Service_user_guide.pdf
- Bureau FTP public products:
  https://www.bom.gov.au/catalogue/anon-ftp.shtml
