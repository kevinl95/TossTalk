# TossTalk

TossTalk is a throwable classroom microphone prototype built for the M5StickC Plus2.

The goal is simple: teachers can turn it on, pair once, and use it like a pass-around classroom mic without extra setup.

## What it does

- Detects when the device is in the air and mutes throw noise
- Recovers quickly so students can speak right away after a catch
- Streams audio to a web app over BLE
- Plays audio through the teacher's connected speakers
- Shows remaining battery on the device screen
- Supports browser-based firmware updates (no Arduino IDE required)

## Teacher workflow

1. Power on TossTalk
2. Open the TossTalk web page in Chrome or Edge (desktop)
3. Connect device
4. Start class and pass/throw the mic

No in-class troubleshooting UI is required for normal use; recovery is automatic.

## Firmware updates (teacher-friendly path)

The web app includes a Flash Firmware button that uses Web Serial in Chromium browsers.

By default, it flashes a prebuilt merged image hosted with the site:

- [web/firmware/tosstalk-merged.bin](web/firmware/tosstalk-merged.bin)

This file is generated automatically by GitHub Actions during deployment.

## Browser support

- Target: Desktop Chromium browsers (Chrome, Edge)
- Mobile browsers: not currently in scope

## Project structure

- [firmware](firmware): Device firmware (PlatformIO)
- [web](web): Browser app (PWA + Web Bluetooth + Web Serial flashing)
- [docs](docs): Architecture, protocol, milestones, test notes
- [.github/workflows](.github/workflows): Build and deployment automation

## For developers

### Local firmware build

1. Open [firmware/platformio.ini](firmware/platformio.ini)
2. Build/upload with PlatformIO

### Local web testing

Serve [web](web) with any static server and open in desktop Chromium.

### Deployment

Push to `main` to:

- deploy the web app to GitHub Pages
- build firmware
- publish updated merged firmware for browser flashing