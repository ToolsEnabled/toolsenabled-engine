'use strict';

// Q51 compatibility entrypoint: the package-owned suite lives under
// tests/repo-protocol while existing package-charter commands keep working.
require('./repo-protocol/build-queue-corpus.js');
