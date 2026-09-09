# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Photographers reviewing a local shoot on macOS or Windows. Their immediate job is to make a fast first-pass keep, reject, or rating decision without moving or deleting original files.

## Product Purpose

Cadris is a keyboard-first local photo-culling application. It makes first-pass selection fast while retaining decisions locally and, on macOS, reflecting keep and reject decisions in Finder tags.

## Positioning

Cadris combines Lightroom CC-inspired keyboard culling with a reversible, local-first workflow and Finder-tag visibility, so photographers can review a library without importing it into a separate catalog or risking originals.

## Operating Context

Users open a photo folder, inspect a grid or a single image, and use Z, X, U, 0–5, arrows, Space, Esc, and +/- during an uninterrupted review pass. They may consult EXIF data, filter by decision, search filenames, and choose whether decisions auto-advance.

## Capabilities and Constraints

- React and TypeScript interface packaged in Tauri 2 for macOS and Windows.
- Grid and loupe views, folder scanning, filename search, decision filters, ratings, EXIF metadata, image zoom, settings, and shortcut feedback.
- Z = keep (green Finder tag), X = reject (red Finder tag), U = clear decision; preserving this functional meaning is mandatory.
- Cadris does not move or delete original images.
- User-requested restyle: iOS 27 Liquid Glass direction; green must not be used as the interface emphasis color.

## Brand Commitments

- Name: Cadris.
- Voice: calm, direct, photographer-oriented, and reassuring about library safety.
- Product behavior remains keyboard-first; visual redesign must not reduce image-review focus.

## Evidence on Hand

- Current UI: `src/App.tsx`, `src/App.css`.
- Desktop configuration: `src-tauri/tauri.conf.json`.
- Product behavior and keyboard reference: `README.md`.
- No user-supplied visual assets or externally verified brand imagery are available.

## Product Principles

1. The photograph, not the application chrome, holds the viewer's attention.
2. Every decision is fast, legible, and safe to correct.
3. Keyboard flow is first-class without excluding mouse or assistive-technology users.
4. Native file-library trust is never compromised for visual effect.

## Accessibility & Inclusion

The entire core review path must remain keyboard operable. Decision state must not rely on color alone, controls need visible focus, and status feedback must be exposed to assistive technology.
