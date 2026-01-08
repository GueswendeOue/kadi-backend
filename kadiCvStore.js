// kadiCvStore.js
"use strict";

const cvs = new Map();

function getCvDraft(userId) {
  if (!cvs.has(userId)) {
    cvs.set(userId, {
      step: 0,
      data: {}
    });
  }
  return cvs.get(userId);
}

function resetCv(userId) {
  cvs.delete(userId);
}

module.exports = {
  getCvDraft,
  resetCv
};