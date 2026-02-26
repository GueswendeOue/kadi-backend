"use strict";

const vision = require("@google-cloud/vision");
const fs = require("fs");
const os = require("os");
const path = require("path");

let _client = null;

function getVisionClient() {
  if (_client) return _client;

  const b64 = process.env.GCP_SA_JSON_B64;
  if (!b64) throw new Error("GCP_SA_JSON_B64 missing");

  const json = Buffer.from(b64, "base64").toString("utf8");
  const filePath = path.join(os.tmpdir(), "gcp-sa.json");
  fs.writeFileSync(filePath, json, "utf8");

  _client = new vision.ImageAnnotatorClient({
    keyFilename: filePath,
  });

  return _client;
}

async function visionOcrImageBuffer(imageBuffer) {
  const client = getVisionClient();
  const [result] = await client.textDetection({
    image: { content: imageBuffer },
  });

  const text = result?.fullTextAnnotation?.text || "";
  return String(text).trim();
}

module.exports = { visionOcrImageBuffer };