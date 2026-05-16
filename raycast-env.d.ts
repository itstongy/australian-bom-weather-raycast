/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `radar` command */
  export type Radar = ExtensionPreferences & {}
  /** Preferences accessible in the `favorite` command */
  export type Favorite = ExtensionPreferences & {}
  /** Preferences accessible in the `forecast` command */
  export type Forecast = ExtensionPreferences & {}
  /** Preferences accessible in the `locations` command */
  export type Locations = ExtensionPreferences & {}
  /** Preferences accessible in the `weather-summary` command */
  export type WeatherSummary = ExtensionPreferences & {}
  /** Preferences accessible in the `warnings` command */
  export type Warnings = ExtensionPreferences & {}
  /** Preferences accessible in the `current-weather` command */
  export type CurrentWeather = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `radar` command */
  export type Radar = {}
  /** Arguments passed to the `favorite` command */
  export type Favorite = {}
  /** Arguments passed to the `forecast` command */
  export type Forecast = {}
  /** Arguments passed to the `locations` command */
  export type Locations = {}
  /** Arguments passed to the `weather-summary` command */
  export type WeatherSummary = {}
  /** Arguments passed to the `warnings` command */
  export type Warnings = {}
  /** Arguments passed to the `current-weather` command */
  export type CurrentWeather = {}
}

