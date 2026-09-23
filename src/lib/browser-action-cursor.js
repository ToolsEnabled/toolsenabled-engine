'use strict';

// Fixed initialization hook for the pinned Playwright MCP. This is attached to
// each owned tab, including tabs discovered after startup. It paints pointer
// movement and action targets without recording video or exposing page code.
module.exports.default = async ({ page }) => {
  await page.screencast.showActions({ duration: 900, position: 'top-right', cursor: 'pointer' });
};
