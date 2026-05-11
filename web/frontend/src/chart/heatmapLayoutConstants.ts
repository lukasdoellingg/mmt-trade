/**
 * Layout and numeric constants for the heatmap / WebGL chart pane.
 * Centralised so names stay readable and margins stay in sync across components.
 */

/** CSS pixels: width reserved for the price scale (right of plot). */
export const CHART_MARGIN_RIGHT_CSS_PX = 80;

/** CSS pixels: height reserved under the plot (time scale + OBI strip). */
export const CHART_MARGIN_BOTTOM_CSS_PX = 32;

/** Float64 fields per candle in shared buffers: t, o, h, l, c, v, closedFlag */
export const CANDLE_FLOAT64_FIELDS = 7;

/** Logical width (CSS px) of the TPO / volume-profile strip inside the right margin. */
export const VOLUME_PROFILE_STRIP_CSS_PX = 110;

/** Minimum horizontal width of one bar in CSS pixels (max zoom out). */
export const MIN_BAR_WIDTH_CSS_PX = 0.5;

/** Minimum bars that must remain “in play” when panning hard left. */
export const MIN_VISIBLE_BARS_COUNT = 2;

/** Volume-profile request debounce (main thread, ms). */
export const VOLUME_PROFILE_REQUEST_COOLDOWN_MS = 220;

/** Device pixel ratio cap for canvases (VRAM / fill-rate). */
export const MAX_DEVICE_PIXEL_RATIO = 2;
