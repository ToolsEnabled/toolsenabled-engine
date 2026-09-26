'use strict';

/**
 * Declares an adapter surface without supplying an adapter implementation.
 * @param {string} name
 * @param {Record<string,{request:string,result:string}>} methodContracts
 * @returns {{name:string,requiredMethods:readonly string[],methodContracts:object,implemented:false}}
 */
function declareAdapter(name, methodContracts) {
  const frozenContracts = Object.freeze(Object.fromEntries(
    Object.entries(methodContracts).map(([method, contract]) => [
      method,
      Object.freeze({ ...contract }),
    ]),
  ));
  return Object.freeze({
    name,
    requiredMethods: Object.freeze(Object.keys(frozenContracts)),
    methodContracts: frozenContracts,
    implemented: false,
  });
}

module.exports = Object.freeze({ declareAdapter });
