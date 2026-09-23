'use strict';

// The browser starts only for a bounded command issued through sandbox.exec.
// Keeping this PID idle avoids an always-on CDP endpoint or browser process.
setInterval(() => {}, 60_000);
