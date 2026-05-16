export const BUREAU_ATTRIBUTION =
  "Weather data sourced from the Bureau of Meteorology. © Bureau of Meteorology.";

export const BUREAU_USAGE_NOTE =
  "For personal, non-commercial use. Bureau data is subject to Bureau of Meteorology copyright, disclaimer, and data service terms.";

export const BUREAU_COPYRIGHT_URL = "https://www.bom.gov.au/copyright";
export const BUREAU_DISCLAIMER_URL = "https://www.bom.gov.au/disclaimer";
export const BUREAU_DATA_SERVICES_URL =
  "https://www.bom.gov.au/resources/data-services";
export const BUREAU_BRAND_POLICY_URL =
  "https://www.bom.gov.au/data-access/brand-trademark-display-policy.shtml";

export function attributionMarkdown() {
  return [
    "## Attribution",
    "",
    BUREAU_ATTRIBUTION,
    "",
    BUREAU_USAGE_NOTE,
    "",
    `- [Bureau copyright notice](${BUREAU_COPYRIGHT_URL})`,
    `- [Bureau disclaimer](${BUREAU_DISCLAIMER_URL})`,
    `- [Bureau data services](${BUREAU_DATA_SERVICES_URL})`,
  ].join("\n");
}
