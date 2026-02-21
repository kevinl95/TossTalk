# Browser flashing (Web Serial)

Target: desktop Chromium browsers.

## Goal

Teachers should flash firmware from a web page without installing Arduino IDE/PlatformIO.

## Status

Implemented in [web/app.js](../web/app.js) using `esptool-js`:

- Loads `esptool-js` in-browser
- Requests serial port permission
- Connects to ESP bootloader
- Uploads flasher stub (when available)
- Flashes selected `.bin` image with progress reporting
- Hard resets device after flash

## Firmware input expectations

- Preferred: merged firmware image (`address = 0x0`)
- Alternative: custom address + matching binary image
- UI supports:
	- hosted firmware URL
	- local firmware file chooser

Default hosted URL in deployed app:

- `./firmware/tosstalk-merged.bin`

This file is generated and published automatically by the Pages workflow.

## Compatibility

- Chrome / Edge desktop: supported path
- Mobile browsers: out of scope