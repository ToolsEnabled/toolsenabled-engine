'use strict';

module.exports = {
  ...require('./errors'),
  ...require('./powershell'),
  ...require('./doctor'),
  requirements: require('./requirements')
};
