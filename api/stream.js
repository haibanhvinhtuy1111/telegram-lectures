// GET /api/stream?id=4676 -> Stream trực tiếp mọi video dung lượng lớn từ Telegram
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const CHANNEL = process.env.TG_CHANNEL || "spankbanggggg";
const API_ID = Number(process.env.TG_API_ID) || 31512968;
const API_HASH = process.env.TG_API_HASH || "562553a691db637e77ca86da3bf948bd";
const SESSION_STR =
  process.env.TG_SESSION ||
  "1BQANOTEuMTA4LjU2LjE4NgG7XBr/db36p5RLigAzRdLxaLh3PWBOyvFIGDGr/nxEp8Hyo0Bs1wMvpdmOVYn1D6Dg6VTShd6VMpy34KL4GJWiGeqHr0+tTtHux4gWxPAHsbKTR23wRhLTm0A9j6CftexKZJUQHtrD4q87SpqXrlwRXBeLKu04zcxcQC7LdNDrPsHCiVZuEs/BpAqyLuRhcEbu5ekK+4rmMI3u74jmRm1/vSMpGng+Fn1OrNKROu8PNq6kcKIGfYPr6d4l1R1BDs2ymVkH11pA1mCUjd4XspNcrD1KnL2BSoixD8tI5WXS8KiHPeeNGsq8mWjQaJzdu3UFXcJ4BKIt/qMVZj5ugv4zEQ==";

const MTPROTO_PART_SIZE = 256 * 1024; // 256 KB
const MAX_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB mỗi chunk

globalThis.__tgMediaCache = globalThis.__tgMediaCache || new Map();

async function getClient() {
  if (!globalThis.__tgClientPromise) {
    const client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
      connectionRetries: 3,
      useWSS: false,
    });
    globalThis.__tgClientPromise = client.connect().then(() => client);
  }
  return globalThis.__tgClientPromise;
}

async function getMediaInfo(client, msgId) {
  const cached = globalThis.__tgMediaCache.get(msgId);
  if (cached && Date.now() - cached.time < 10 * 60 * 1000) {
    return cached;
  }
  const [msg] = await client.getMessages(CHANNEL, { ids: [msgId] });
  const doc = msg?.media?.document;
  if (!doc) return null;

  const info = {
    media: msg.media,
    size: Number(doc.size),
    mimeType: doc.mimeType || "video/mp4",
    time: Date.now(),
  };
  globalThis.__tgMediaCache.set(msgId, info);
  return info;
}

module.exports = async (req, res) => {
  const msgId = Number(req.query.id);
  if (!msgId) return res.status(400).end("Missing video id");

  try {
    const client = await getClient();
    const info = await getMediaInfo(client, msgId);
    if (!info) return res.status(404).end("Video not found");

    const fileSize = info.size;
    const range = req.headers.range;

    let reqStart = 0;
    let reqEnd = Math.min(MAX_CHUNK_SIZE - 1, fileSize - 1);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      reqStart = parseInt(parts[0], 10) || 0;
      reqEnd = parts[1]
        ? Math.min(parseInt(parts[1], 10), reqStart + MAX_CHUNK_SIZE - 1, fileSize - 1)
        : Math.min(reqStart + MAX_CHUNK_SIZE - 1, fileSize - 1);
    }

    if (reqStart >= fileSize) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      return res.end();
    }

    const desiredLength = reqEnd - reqStart + 1;
    const alignedStart = Math.floor(reqStart / MTPROTO_PART_SIZE) * MTPROTO_PART_SIZE;
    const skipBytes = reqStart - alignedStart;
    const bytesToFetch = skipBytes + desiredLength;

    const chunks = [];
    let fetched = 0;

    for await (const chunk of client.iterDownload({
      file: info.media,
      offset: BigInt(alignedStart),
      requestSize: MTPROTO_PART_SIZE,
    })) {
      chunks.push(chunk);
      fetched += chunk.length;
      if (fetched >= bytesToFetch) break;
    }

    const fullBuffer = Buffer.concat(chunks);
    const slice = fullBuffer.subarray(skipBytes, skipBytes + desiredLength);
    const actualEnd = reqStart + slice.length - 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${reqStart}-${actualEnd}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": slice.length,
      "Content-Type": info.mimeType,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(slice);
  } catch (e) {
    globalThis.__tgMediaCache.delete(msgId);
    res.status(500).json({ error: String(e.message || e) });
  }
};
