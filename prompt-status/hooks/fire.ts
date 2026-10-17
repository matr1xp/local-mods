// The animated context bar as Raster cells, a tall flame or a one-row flow,
// plus the odometer easing. Adapted from burn-meter (OneWave-AI/claude-code-mods,
// MIT). The same file lives in token-usage and prompt-status: keep them identical.

export const FIRE_ROWS = 3

const DEFAULT = 0x01000000
const MOSS = 0x7fa88a
const LIME = 0xbef264
const GREEN = 0x4ade80
const EMERALD = 0x16a34a
const PINE = 0x0b5d2e
const MINT = 0xecfdf3
const EMPTY = 0x232a25

// ' ▁▂▃▄▅▆▇█' by eighths.
const EIGHTHS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

const mix = (a: number, b: number, t: number): number => {
  const ch = (shift: number) =>
    Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** Moss, then green, then emerald as `heat` goes 0..1. */
const flame = (heat: number) =>
  heat < 0.5 ? mix(MOSS, GREEN, heat * 2) : mix(GREEN, EMERALD, (heat - 0.5) * 2)

/** Mint base, lime, green, deeper green tips, at height `y` 0..1 inside a flame. */
const flameAt = (y: number, heat: number) => {
  const tip = mix(EMERALD, PINE, Math.min(1, 0.3 + heat))
  if (y < 0.25) return mix(MINT, LIME, y * 4)
  if (y < 0.6) return mix(LIME, GREEN, (y - 0.25) / 0.35)
  return mix(GREEN, tip, (y - 0.6) / 0.4)
}

/** Cheap smooth noise from two beating sines, 0..1. */
const wobble = (x: number, t: number) =>
  0.5 + 0.25 * Math.sin(t * 9.1 + x * 1.7) + 0.25 * Math.sin(t * 5.3 - x * 2.9 + Math.sin(t * 2 + x))

/**
 * One frame of the context bar, `columns` wide and `rows` tall, at time `t`
 * in seconds: the bottom row filled to `percent`, flames dancing over the
 * filled part (tallest at the leading edge, taller and deeper green as it fills).
 */
export const fireCells = (columns: number, percent: number, t: number, rows = FIRE_ROWS): string => {
  const heat = Math.min(1, Math.max(0, percent / 100))
  const words = new Uint32Array(columns * rows * 3)
  const filled = Math.max(1, Math.round(heat * columns))
  const flameRows = rows - 1
  const put = (x: number, y: number, glyph: number, fg: number) => {
    const i = (y * columns + x) * 3
    words[i] = glyph
    words[i + 1] = fg
    words[i + 2] = DEFAULT
  }
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y < flameRows; y++) put(x, y, 0x20, DEFAULT)
    if (x >= filled) {
      put(x, rows - 1, 0x2591, EMPTY) // ░
      continue
    }
    const along = filled <= 1 ? 1 : x / (filled - 1)
    const isEdge = x === filled - 1
    put(x, rows - 1, 0x2588, isEdge && Math.floor(t * 14) % 2 === 0 ? MINT : mix(MOSS, flame(along * heat), along))
    const lead = 1 - Math.min(1, (filled - 1 - x) / Math.max(4, filled * 0.6))
    const height = flameRows * 8 * Math.min(1, (0.35 + 0.4 * heat + 0.45 * lead) * (0.35 + 0.9 * wobble(x, t)))
    for (let y = 0; y < flameRows; y++) {
      const fromBottom = flameRows - 1 - y
      const eighths = Math.max(0, Math.min(8, Math.round(height - fromBottom * 8)))
      if (eighths > 0) put(x, y, EIGHTHS[eighths]!, flameAt(fromBottom / flameRows + eighths / (8 * flameRows), heat))
    }
    // A spark off the top now and then.
    if (height < 9 && wobble(x * 3.1, t * 1.7) > 0.86) {
      put(x, 0, Math.floor(t * 10 + x) % 2 ? 0xb7 : 0x2a, mix(LIME, GREEN, heat))
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

// '▏▎▍▌▋▊▉█' by eighths, filling from the left.
const LEFT_EIGHTHS = [0x20, 0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589, 0x2588]

/**
 * One frame of the context bar as a single row, `columns` wide, at time `t`
 * in seconds: filled to `percent`, bright bands flowing along the fill toward
 * a leading edge that licks back and forth, sparks drifting just ahead of it.
 */
export const flowCells = (columns: number, percent: number, t: number): string => {
  const heat = Math.min(1, Math.max(0, percent / 100))
  const words = new Uint32Array(columns * 3)
  const exact = heat * columns
  // The edge flickers by up to most of a cell, never below a sliver of fill.
  const tip = Math.min(columns, Math.max(0.25, exact + 0.75 * (wobble(exact, t) - 0.5)))
  const put = (x: number, glyph: number, fg: number) => {
    words[x * 3] = glyph
    words[x * 3 + 1] = fg
    words[x * 3 + 2] = DEFAULT
  }
  for (let x = 0; x < columns; x++) {
    const cover = Math.min(1, Math.max(0, tip - x))
    if (cover >= 1) {
      const along = tip <= 1 ? 1 : x / (tip - 1)
      const base = mix(MOSS, flame(along * heat), Math.min(1, along))
      const wave = Math.pow(0.5 + 0.5 * Math.sin(x * 0.8 - t * 6), 3)
      const hot = Math.max(0, 1 - (tip - 1 - x) / 2)
      put(x, 0x2588, mix(mix(base, LIME, 0.5 * wave), MINT, 0.6 * hot))
      continue
    }
    const eighths = Math.round(cover * 8)
    if (eighths > 0) {
      put(x, LEFT_EIGHTHS[eighths]!, MINT)
    } else if (x - tip < 3 && wobble(x * 3.1, t * 1.7) > 0.8) {
      put(x, Math.floor(t * 10 + x) % 2 ? 0xb7 : 0x2a, mix(LIME, GREEN, heat))
    } else {
      put(x, 0x2591, EMPTY) // ░
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

/** Steps `shown` toward `target`: an odometer that eases but always lands. */
export const tween = (shown: number, target: number): number => {
  const gap = target - shown
  if (Math.abs(gap) < 0.0005) return target
  const step = gap * 0.22
  return shown + (Math.abs(step) < 0.0005 ? Math.sign(gap) * 0.0005 : step)
}
