# Attendance — app icon & brand assets

## The mark

Three layers, one gesture:

| Layer | Reads as |
| --- | --- |
| Pale ring (`#BFDBFE`) | the full shift / the whole working day |
| Blue arc over it (`#2563EB`), ~292° | hours already logged — a progress ring, not a clock face |
| Check punching out through the gap | the clock-in: attendance confirmed |

The check breaks the ring's outline instead of sitting politely inside it, which gives
the mark a silhouette you can pick out at 16px and keeps it from reading as
"generic clock with a tick." No hands, no hour ticks, no text.

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| Brand blue | `#2563EB` | progress arc + check |
| Deep blue | `#1D4ED8` | app-icon tile background |
| Pale blue | `#BFDBFE` | the dial / untracked hours |
| Ink | `#0B1B3A` | wordmark |
| Slate | `#64748B` | tagline |
| White | `#FFFFFF` | reversed lockups |

Flat fills only — no gradients, shadows, or effects.

## Files

| File | Use |
| --- | --- |
| `logo-icon.svg` | Primary icon, 64pt grid, transparent — navbar, sidebar |
| `app-icon.svg` | 512×512 rounded tile — iOS / Android / PWA |
| `app-icon-transparent.svg` | 512×512, no tile — when the platform supplies the shape |
| `favicon.svg` | Simplified, thicker strokes, dial dropped for 16px |
| `logo-icon-mono-white.svg` | Icon on dark or photographic backgrounds |
| `logo-horizontal.svg` | Icon + "Attendance" — main lockup |
| `logo-horizontal-tagline.svg` | Lockup + "TIME & ATTENDANCE TRACKING" |
| `logo-horizontal-white.svg` | Reversed lockup for dark headers |
| `preview.html` | Contact sheet — open in a browser to review every size |
| `export-png.html` | Open in a browser, click once, get every PNG size |
| `concepts/` | Rejected directions, kept for reference |

## Rules

- Clear space: one stroke width (7 units on the 64 grid) on all sides. The check tip
  extends ~1 unit past the ring — measure clear space from the tip, not the ring.
- Minimum size: 16px for `favicon.svg`, 20px for `logo-icon.svg`.
- Don't rotate, stretch, recolor, or add effects. On busy or dark backgrounds use the
  white version, never the two-tone one.
- The wordmark uses a font stack (Inter → Segoe UI → system-ui). Convert `<text>` to
  outlines if you need byte-identical rendering off the web.

## Wiring it up

```html
<link rel="icon" href="assets/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="assets/brand/app-icon-180.png">
<img src="assets/brand/logo-horizontal.svg" alt="Attendance" height="36">
```
