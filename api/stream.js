// File: api/stream.js
// GET /api/stream?id=4673 -> Stream trực tiếp video dung lượng lớn (Hỗ trợ Cross-DC)
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

let bigInt;
try {
  bigInt = require("big-integer");
} catch {
  bigInt = require("telegram/node_modules/big-integer");
}

const CHANNEL = process.env.TG_CHANNEL || "spankbanggggg";
const API_ID = Number(process.env.TG_API_ID) || 31512968;
const API_HASH = process.env.TG_API_HASH || "562553a691db637e77ca86da3bf948bd";
const SESSION_STR = (
  process.env.TG_SESSION ||
  "1BQANOTEuMTA4LjU2LjE4NgG7XBr/db36p5RLigAzRdLxaLh3PWBOyvFIGDGr/nxEp8Hyo0Bs1wMvpdmOVYn1D6Dg6VTShd6VMpy34KL4GJWiGeqHr0+tTtHux4gWxPAHsbKTR23wRhLTm0A9j6CftexKZJUQHtrD4q87SpqXrlwRXBeLKu04zcxcQC7LdNDrPsHCiVZuEs/BpAqyLuRhcEbu5ekK+4rmMI3u74jmRm1/vSMpGng+Fn1OrNKROu8PNq6kcKIGfYPr6d4l1R1BDs2ymVkH11pA1mCUjd4XspNcrD1KnL2BSoixD8tI5WXS8KiHPeeNGsq8mWjQaJzdu3UFXcJ4BKIt/qMVZj5ugv4zEQ=="
).trim();

// 512 KB là kích thước chuẩn tối đa của 1 lệnh upload.GetFile trong MTProto
const BLOCK_SIZE = 512 * 1024;

globalThis.__tgMediaCache = globalThis.__tgMediaCache || new Map();
globalThis.__tgDcSenders = globalThis.__tgDcSenders || new Map();

async function getClient() {
  if (globalThis.__tgClient && globalThis.__tgClient.connected) {
    return globalThis.__tgClient;
  }
  if (!globalThis.__tgClientPromise) {
    globalThis.__tgClientPromise = (async () => {
      const client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
        connectionRetries: 5,
        useWSS: false,
      });
      await client.connect();
      globalThis.__tgClient = client;
      return client;
    })().catch((err) => {
      globalThis.__tgClientPromise = null;
      globalThis.__tgClient = null;
      throw err;
    });
  }
  return globalThis.__tgClientPromise;
}

// Khởi tạo và xác thực kết nối tới cụm máy chủ (DC) chứa video
async function getAuthorizedSender(client, dcId, forceReset = false) {
  if (dcId === client.session.dcId) {
    return client._sender;
  }
  if (forceReset) {
    globalThis.__tgDcSenders.delete(dcId);
  }
  if (!globalThis.__tgDcSenders.has(dcId)) {
    const promise = (async () => {
      const sender = await client.getSender(dcId);
      if (!sender.isConnected()) {
        await sender.connect();
      }
      try {
        const exported = await client.invoke(new Api.auth.ExportAuthorization({ dcId }));
        await sender.send(
          client._initWith(
            new Api.auth.ImportAuthorization({
              id: exported.id,
              bytes: exported.bytes,
            })
          )
        );
      } catch (e) {
        // Nếu sender đã được import auth từ trước thì chỉ cần đảm bảo InitConnection
        const msg = String(e.errorMessage || e.message || "");
        if (!msg.includes("AUTH_KEY_DUPLICATED")) {
          try {
            await sender.send(client._initWith(new Api.help.GetConfig()));
          } catch (_) {}
        }
      }
      return sender;
    })().catch((err) => {
      globalThis.__tgDcSenders.delete(dcId);
      throw err;
    });

    globalThis.__tgDcSenders.set(dcId, promise);
  }
  return globalThis.__tgDcSenders.get(dcId);
}

// Tải 1 khối 512 KB từ đúng DC chứa file
async function downloadBlock(client, info, alignedOffset) {
  const location = new Api.InputDocumentFileLocation({
    id: info.id,
    accessHash: info.accessHash,
    fileReference: info.fileReference,
    thumbSize: "",
  });

  const req = new Api.upload.GetFile({
    location,
    offset: bigInt(alignedOffset),
    limit: BLOCK_SIZE,
  });

  if (info.dcId === client.session.dcId) {
    const res = await client.invoke(req);
    return Buffer.from(res.bytes);
  }

  let sender = await getAuthorizedSender(client, info.dcId);
  try {
    const res = await sender.send(req);
    return Buffer.from(res.bytes);
  } catch (err) {
    const errMsg = String(err.errorMessage || err.message || "");

    if (errMsg.includes("CONNECTION_NOT_INITED")) {
      const res = await sender.send(client._initWith(req));
      return Buffer.from(res.bytes);
    }

    if (errMsg.includes("AUTH_KEY_UNREGISTERED") || errMsg.includes("USER_MIGRATE")) {
      sender = await getAuthorizedSender(client, info.dcId, true);
      const res = await sender.send(client._initWith(req));
      return Buffer.from(res.bytes);
    }

    const migrateMatch = errMsg.match(/FILE_MIGRATE_(\d+)/);
    if (migrateMatch) {
      info.dcId = Number(migrateMatch[1]);
      sender = await getAuthorizedSender(client, info.dcId);
      const res = await sender.send(client._initWith(req));
      return Buffer.from(res.bytes);
    }

    throw err;
  }
}

async function getMediaInfo(client, msgId, forceRefresh = false) {
  const cached = globalThis.__tgMediaCache.get(msgId);
  if (!forceRefresh && cached && Date.now() - cached.time < 10 * 60 * 1000) {
    return cached;
  }

  const msgs = await client.getMessages(CHANNEL, { ids: [msgId] });
  const msg = msgs && msgs[0];
  const doc = msg?.media?.document;
  if (!doc) return null;

  const info = {
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    dcId: doc.dcId,
    size: Number(doc.size),
    mimeType: doc.mimeType || "video/mp4",
    time: Date.now(),
  };
  globalThis.__tgMediaCache.set(msgId, info);
  return info;
}

module.exports = async (req, res) => {
  const msgId = Number(req.query.id);
  if (!msgId) return res.status(400).json({ error: "Thiếu id bài giảng" });

  try {
    const client = await getClient();
    let info = await getMediaInfo(client, msgId);
    if (!info) return res.status(404).json({ error: "Không tìm thấy video trong bài giảng này" });

    const fileSize = info.size;

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": fileSize,
        "Content-Type": info.mimeType,
      });
      return res.end();
    }

    const range = req.headers.range;
    let reqStart = 0;
    let hasExplicitEnd = false;
    let explicitEnd = fileSize - 1;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      reqStart = parseInt(parts[0], 10) || 0;
      if (parts[1]) {
        hasExplicitEnd = true;
        explicitEnd = Math.min(parseInt(parts[1], 10), fileSize - 1);
      }
    }

    if (reqStart >= fileSize || reqStart < 0) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      return res.end();
    }

    const alignedStart = Math.floor(reqStart / BLOCK_SIZE) * BLOCK_SIZE;

    let rawChunk;
    try {
      rawChunk = await downloadBlock(client, info, alignedStart);
    } catch (err) {
      // Nếu file_reference hết hạn, làm mới lại thông tin tin nhắn và tải lại
      if (String(err.errorMessage || err.message || "").includes("FILE_REFERENCE")) {
        info = await getMediaInfo(client, msgId, true);
        rawChunk = await downloadBlock(client, info, alignedStart);
      } else {
        throw err;
      }
    }

    // Nếu điểm bắt đầu nằm ở cuối khối 512 KB, tải nối thêm khối tiếp theo để trình duyệt không bị hụt dữ liệu
    const skipBytes = reqStart - alignedStart;
    if (
      rawChunk.length - skipBytes < 128 * 1024 &&
      alignedStart + BLOCK_SIZE < fileSize &&
      (!hasExplicitEnd || explicitEnd > alignedStart + BLOCK_SIZE - 1)
    ) {
      try {
        const nextChunk = await downloadBlock(client, info, alignedStart + BLOCK_SIZE);
        rawChunk = Buffer.concat([rawChunk, nextChunk]);
      } catch (_) {}
    }

    const maxAvailableEnd = alignedStart + rawChunk.length - 1;
    const reqEnd = hasExplicitEnd ? Math.min(explicitEnd, maxAvailableEnd) : maxAvailableEnd;
    const takeBytes = Math.max(0, reqEnd - reqStart + 1);
    const slice = rawChunk.subarray(skipBytes, skipBytes + takeBytes);
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
    res.status(500).json({ error: String(e.errorMessage || e.message || e) });
  }
};
