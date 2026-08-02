"use strict";

function createDeferredPrivateFileAccess() {
  return Object.freeze({
    async createTemporaryAccess() {
      return { ok: false, error: "FINAL_FILE_ACCESS_NOT_CONFIGURED" };
    },
  });
}

module.exports = { createDeferredPrivateFileAccess };
