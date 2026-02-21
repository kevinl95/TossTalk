# Browser flashing (Web Serial)

Target: desktop Chromium browsers.

## Goal

Teachers should flash firmware from a web page without installing Arduino IDE/PlatformIO.

## Status

Bootstrap is implemented in [web/app.js](../web/app.js):

- Requests serial port permission
- Opens and closes port successfully

Full flashing integration with `esptool-js` is pending the next milestone.

## Compatibility

- Chrome / Edge desktop: supported path
- Mobile browsers: out of scope