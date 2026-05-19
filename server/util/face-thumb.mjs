// Face thumbnail storage — crops via the InsightFace sidecar /crop endpoint.

import fs from "node:fs/promises";
import path from "node:path";
import { request } from "node:http";
import { URL } from "node:url";

const FACE_EMBEDDER_URL = process.env.FACE_EMBEDDER_URL ?? "http://127.0.0.1:8765";
export const FACE_THUMB_ROOT =
  process.env.FACE_THUMB_DIR ?? path.resolve(process.cwd(), "data/face-thumbs");

/** Relative path stored in SQLite (e.g. match/42.jpg). */
export function thumbRelPath(kind, id) {
  const safeKind = String(kind).replace(/[^a-z0-9_-]/gi, "");
  const safeId = Number(id);
  if (!safeKind || !Number.isInteger(safeId) || safeId <= 0) {
    throw new Error("invalid thumb kind/id");
  }
  return `${safeKind}/${safeId}.jpg`;
}

export function resolveThumbAbs(relPath) {
  if (!relPath || typeof relPath !== "string") throw new Error("missing thumb path");
  const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = path.resolve(FACE_THUMB_ROOT, normalized);
  const root = path.resolve(FACE_THUMB_ROOT);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error("thumb path escape");
  }
  return abs;
}

function postCrop(imageBuffer, bboxAbs, { maxPx = 256, padding = 0.12, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL("/crop", FACE_EMBEDDER_URL);
    } catch (err) {
      return reject(err);
    }
    const boundary = "--av-" + Math.random().toString(36).slice(2);
    const bboxField = JSON.stringify(bboxAbs.map((n) => Number(n)));
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="bbox"\r\n\r\n` +
      `${bboxField}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="max_px"\r\n\r\n` +
      `${Math.round(maxPx)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="padding"\r\n\r\n` +
      `${padding}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="frame.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(head), imageBuffer, Buffer.from(tail)]);

    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            return reject(new Error(`crop_http_${res.statusCode}: ${buf.toString("utf8").slice(0, 200)}`));
          }
          if (!buf.length) return reject(new Error("crop_empty"));
          resolve(buf);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("crop_timeout")));
    req.end(body);
  });
}

/**
 * Crop face from frame and write JPEG under data/face-thumbs/.
 * @returns {Promise<string>} relative path for DB
 */
export async function saveFaceThumb(imageBuffer, bboxAbs, { kind, id, maxPx = 256 } = {}) {
  if (!imageBuffer?.length || !Array.isArray(bboxAbs) || bboxAbs.length !== 4) {
    throw new Error("saveFaceThumb: bad input");
  }
  const jpeg = await postCrop(imageBuffer, bboxAbs, { maxPx });
  const rel = thumbRelPath(kind, id);
  const abs = resolveThumbAbs(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, jpeg);
  return rel;
}

export async function readFaceThumb(relPath) {
  const abs = resolveThumbAbs(relPath);
  return fs.readFile(abs);
}
