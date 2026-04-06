"use strict";

const _userLocks = new Map();

async function withUserLock(waId, fn) {
  const key = String(waId || "").trim();
  if (!key) return fn();

  const previous = _userLocks.get(key) || Promise.resolve();

  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  _userLocks.set(key, previous.then(() => current));

  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (_userLocks.get(key) === current) {
      _userLocks.delete(key);
    }
  }
}

module.exports = {
  withUserLock,
};