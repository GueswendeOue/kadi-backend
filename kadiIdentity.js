"use strict";

const {
  getOrCreateProfile,
  updateProfileByIdentity,
} = require("./store");

function extractMetaIdentity(value = {}) {
  const contact = value?.contacts?.[0] || {};
  const msg = value?.messages?.[0] || {};
  const status = value?.statuses?.[0] || {};

  const waId =
    contact?.wa_id ||
    msg?.from ||
    status?.recipient_id ||
    null;

  const bsuid =
    contact?.user_id ||
    msg?.from_user_id ||
    status?.recipient_user_id ||
    null;

  const parentBsuid =
    contact?.parent_user_id ||
    msg?.from_parent_user_id ||
    status?.parent_recipient_user_id ||
    null;

  const username = contact?.profile?.username || null;
  const profileName = contact?.profile?.name || null;

  return {
    waId: waId ? String(waId).trim() : null,
    bsuid: bsuid ? String(bsuid).trim() : null,
    parentBsuid: parentBsuid ? String(parentBsuid).trim() : null,
    username: username ? String(username).trim() : null,
    profileName: profileName ? String(profileName).trim() : null,
  };
}

function resolveOwnerKey(identity = {}) {
  return identity?.waId || identity?.bsuid || null;
}

async function syncMetaIdentity(identity = {}) {
  const waId = identity?.waId || null;
  const bsuid = identity?.bsuid || null;
  const parentBsuid = identity?.parentBsuid || null;
  const username = identity?.username || null;
  const profileName = identity?.profileName || null;

  if (!waId && !bsuid) return null;

  const profile = await getOrCreateProfile(waId, {
    bsuid,
    parentBsuid,
    username,
    profileName,
  });

  const patch = {};

  if (bsuid && profile?.bsuid !== bsuid) {
    patch.bsuid = bsuid;
  }

  if (parentBsuid && profile?.parent_bsuid !== parentBsuid) {
    patch.parent_bsuid = parentBsuid;
  }

  if (username && profile?.whatsapp_username !== username) {
    patch.whatsapp_username = username;
  }

  if (profileName && !profile?.owner_name) {
    patch.owner_name = profileName;
  }

  if (Object.keys(patch).length > 0) {
    await updateProfileByIdentity({ waId, bsuid }, patch);
  }

  return profile;
}

module.exports = {
  extractMetaIdentity,
  resolveOwnerKey,
  syncMetaIdentity,
};