const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const QRCode = require("qrcode");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3011);
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, "storage", "uploads");
const chunkDir = path.join(__dirname, "storage", "chunks");
const basePath = normaliseBasePath(process.env.BASE_PATH || "");
const fileTtlHours = Number(process.env.FILE_TTL_HOURS || 24);
const cleanupIntervalMinutes = Number(process.env.CLEANUP_INTERVAL_MINUTES || 15);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 10240);
const maxUploadBytes = maxUploadMb * 1024 * 1024;
const roomTtlHours = Number(process.env.ROOM_TTL_HOURS || 24);
const maxClipboardBytes = 1024 * 1024;

const state = {
  inbox: [],
  shares: new Map(),
  desktopRooms: new Map(),
  clipboardRooms: new Map(),
  files: new Map(),
  uploadSessions: new Map(),
  phoneClipboard: {
    text: "",
    updatedAt: null,
  },
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function text(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(payload);
}

function normaliseBasePath(input) {
  if (!input || input === "/") {
    return "";
  }

  const trimmed = input.trim().replace(/\/+$/g, "");
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function withBasePath(routePath) {
  if (!basePath) {
    return routePath;
  }

  if (routePath === "/") {
    return `${basePath}/`;
  }

  return `${basePath}${routePath}`;
}

function getRequestOrigin(req) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${req.headers.host}`;
}

function getExpiryTimeMs(record) {
  return new Date(record.createdAt).getTime() + fileTtlHours * 60 * 60 * 1000;
}

function isExpired(record, now = Date.now()) {
  return Number.isFinite(getExpiryTimeMs(record)) && getExpiryTimeMs(record) <= now;
}

async function serveFile(res, filePath) {
  try {
    const contents = await fsp.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };

    res.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream" });
    res.end(contents);
  } catch (error) {
    json(res, 404, { error: "Not found." });
  }
}

async function serveIndex(req, res) {
  try {
    const template = await fsp.readFile(path.join(publicDir, "index.html"), "utf8");
    const html = template
      .replaceAll("__BASE_PATH__", basePath || "")
      .replaceAll("__APP_ORIGIN__", getRequestOrigin(req));

    text(res, 200, html, "text/html; charset=utf-8");
  } catch (error) {
    json(res, 500, { error: "Unable to load page." });
  }
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^\w.\-() ]+/g, "_").slice(0, 180) || "file";
}

function normaliseDisplayName(fileName) {
  return (fileName || "file")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, 240) || "file";
}

function getDownloadName(fileName) {
  return sanitizeFileName(path.posix.basename(normaliseDisplayName(fileName)));
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function serialiseFile(record) {
  return {
    id: record.id,
    originalName: record.originalName,
    size: record.size,
    sizeLabel: formatBytes(record.size),
    createdAt: record.createdAt,
    downloadPath: withBasePath(`/api/files/${record.id}`),
    mimeType: record.mimeType,
    source: record.source,
  };
}

function getTopLevelFolder(fileName) {
  const normalised = normaliseDisplayName(fileName);
  if (!normalised.includes("/")) {
    return null;
  }

  return normalised.split("/")[0] || null;
}

function serialiseRoom(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    lastSeenAt: room.lastSeenAt,
    files: room.fileIds
      .map((fileId) => state.files.get(fileId))
      .filter(Boolean)
      .map(serialiseFile),
  };
}

function serialiseClipboardRoom(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    lastSeenAt: room.lastSeenAt,
    clipboard: {
      text: room.clipboardText || "",
      updatedAt: room.clipboardUpdatedAt || null,
    },
  };
}

async function handleDesktopRoomBundleDownload(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = normaliseRoomCode(requestUrl.searchParams.get("code") || "");
  const folder = normaliseDisplayName(requestUrl.searchParams.get("folder") || "");
  const room = state.desktopRooms.get(code);

  if (!code || !room || isRoomExpired(room)) {
    if (room && isRoomExpired(room)) {
      await deleteDesktopRoom(code);
    }
    json(res, 404, { error: "Room not found." });
    return;
  }

  const roomFiles = room.fileIds
    .map((fileId) => state.files.get(fileId))
    .filter(Boolean)
    .filter((file) => file.originalName.startsWith(`${folder}/`));

  if (!folder || !roomFiles.length) {
    json(res, 404, { error: "Folder not found." });
    return;
  }

  touchRoom(room);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "file-transfer-bundle-"));

  try {
    for (const file of roomFiles) {
      const targetPath = path.join(tempRoot, normaliseDisplayName(file.originalName));
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.copyFile(file.filePath, targetPath);
    }

    const downloadName = `${sanitizeFileName(folder)}.tar.gz`;
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    });

    const tarProcess = spawn("/usr/bin/tar", ["-czf", "-", "-C", tempRoot, folder]);
    tarProcess.stdout.pipe(res);
    tarProcess.stderr.on("data", () => {});
    tarProcess.on("close", async () => {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    });
    tarProcess.on("error", async () => {
      await fsp.rm(tempRoot, { recursive: true, force: true });
      if (!res.headersSent) {
        json(res, 500, { error: "Unable to create folder archive." });
      } else {
        res.end();
      }
    });
  } catch (error) {
    await fsp.rm(tempRoot, { recursive: true, force: true });
    json(res, 500, { error: "Unable to prepare folder archive." });
  }
}

function serialiseShare(share) {
  return {
    id: share.id,
    createdAt: share.createdAt,
    downloadPath: withBasePath(`/download/${share.id}`),
    files: share.fileIds
      .map((fileId) => state.files.get(fileId))
      .filter(Boolean)
      .map(serialiseFile),
  };
}

function pruneInMemoryState() {
  const now = Date.now();

  for (const [fileId, record] of state.files.entries()) {
    if (isExpired(record, now)) {
      state.files.delete(fileId);
    }
  }

  state.inbox = state.inbox.filter((fileId) => state.files.has(fileId));

  for (const [shareId, share] of state.shares.entries()) {
    share.fileIds = share.fileIds.filter((fileId) => state.files.has(fileId));
    const shareExpired = new Date(share.createdAt).getTime() + fileTtlHours * 60 * 60 * 1000 <= now;

    if (shareExpired && share.fileIds.length === 0) {
      state.shares.delete(shareId);
    }
  }

  for (const room of state.desktopRooms.values()) {
    room.fileIds = room.fileIds.filter((fileId) => state.files.has(fileId));
  }
}

function isRoomExpired(room, now = Date.now()) {
  return new Date(room.lastSeenAt).getTime() + roomTtlHours * 60 * 60 * 1000 <= now;
}

function touchRoom(room) {
  room.lastSeenAt = new Date().toISOString();
}

async function deleteFileRecord(fileId) {
  const record = state.files.get(fileId);
  if (!record) {
    return;
  }

  state.files.delete(fileId);
  state.inbox = state.inbox.filter((id) => id !== fileId);

  for (const share of state.shares.values()) {
    share.fileIds = share.fileIds.filter((id) => id !== fileId);
  }

  for (const room of state.desktopRooms.values()) {
    room.fileIds = room.fileIds.filter((id) => id !== fileId);
  }

  try {
    await fsp.unlink(record.filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Failed to delete expired file ${record.filePath}:`, error);
    }
  }
}

async function cleanupExpiredFiles() {
  const now = Date.now();
  const expiredFileIds = [];

  for (const [fileId, record] of state.files.entries()) {
    if (isExpired(record, now)) {
      expiredFileIds.push(fileId);
    }
  }

  for (const fileId of expiredFileIds) {
    await deleteFileRecord(fileId);
  }

  try {
    const entries = await fsp.readdir(uploadDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(uploadDir, entry.name);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs + fileTtlHours * 60 * 60 * 1000 <= now) {
          await fsp.unlink(filePath);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error(`Failed to inspect uploaded file ${filePath}:`, error);
        }
      }
    }
  } catch (error) {
    console.error("Failed to scan upload directory for expired files:", error);
  }

  for (const [sessionId, session] of state.uploadSessions.entries()) {
    const sessionExpired = new Date(session.createdAt).getTime() + fileTtlHours * 60 * 60 * 1000 <= now;
    if (sessionExpired) {
      await deleteUploadSession(sessionId);
    }
  }

  const expiredRoomCodes = [];
  for (const [roomCode, room] of state.desktopRooms.entries()) {
    if (isRoomExpired(room, now)) {
      expiredRoomCodes.push(roomCode);
    }
  }

  for (const roomCode of expiredRoomCodes) {
    await deleteDesktopRoom(roomCode);
  }

  const expiredClipboardRoomCodes = [];
  for (const [roomCode, room] of state.clipboardRooms.entries()) {
    if (isRoomExpired(room, now)) {
      expiredClipboardRoomCodes.push(roomCode);
    }
  }

  for (const roomCode of expiredClipboardRoomCodes) {
    state.clipboardRooms.delete(roomCode);
  }

  pruneInMemoryState();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        reject(new Error("File is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readTextBody(req, maxBytes = maxClipboardBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Text is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req, maxBytes = maxClipboardBytes) {
  const textBody = await readTextBody(req, maxBytes);
  try {
    return textBody ? JSON.parse(textBody) : {};
  } catch (error) {
    throw new Error("Invalid JSON body.");
  }
}

function readMultipartPartHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function extractDispositionParams(disposition) {
  const params = {};

  for (const part of disposition.split(";").slice(1)) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = part.slice(separatorIndex + 1).trim();
    params[key] = rawValue.replace(/^"|"$/g, "");
  }

  return params;
}

function parseMultipartUpload(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary.");
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let offset = 0;

  while (offset < buffer.length) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, offset);
    if (boundaryIndex === -1) {
      break;
    }

    let cursor = boundaryIndex + boundaryBuffer.length;
    if (buffer.slice(cursor, cursor + 2).toString() === "--") {
      break;
    }

    if (buffer.slice(cursor, cursor + 2).toString() === "\r\n") {
      cursor += 2;
    }

    const headerEndIndex = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEndIndex === -1) {
      break;
    }

    const headerText = buffer.slice(cursor, headerEndIndex).toString("utf8");
    const headers = readMultipartPartHeaders(headerText);
    const disposition = headers["content-disposition"] || "";
    const params = extractDispositionParams(disposition);
    const contentStartIndex = headerEndIndex + 4;
    const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, contentStartIndex);

    if (nextBoundaryIndex === -1) {
      break;
    }

    let contentEndIndex = nextBoundaryIndex;
    if (buffer.slice(contentEndIndex - 2, contentEndIndex).toString() === "\r\n") {
      contentEndIndex -= 2;
    }

    if (params.name === "file") {
      return {
        originalName: params.filename || "upload.bin",
        mimeType: headers["content-type"] || "application/octet-stream",
        buffer: buffer.slice(contentStartIndex, contentEndIndex),
      };
    }

    offset = nextBoundaryIndex;
  }

  throw new Error("No uploaded file found.");
}

async function readUploadPayload(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const contentType = req.headers["content-type"] || "application/octet-stream";
  const buffer = await readBody(req);

  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    return parseMultipartUpload(buffer, contentType);
  }

  return {
    originalName: requestUrl.searchParams.get("filename") || req.headers["x-file-name"] || "upload.bin",
    mimeType: contentType,
    buffer,
  };
}

async function saveUploadedFile({ buffer, originalName, mimeType, source, shareId = null }) {
  const id = crypto.randomUUID();
  const displayName = normaliseDisplayName(originalName || "file");
  const safeName = sanitizeFileName(displayName);
  const storedName = `${id}-${safeName}`;
  const filePath = path.join(uploadDir, storedName);

  await fsp.writeFile(filePath, buffer);

  const record = {
    id,
    originalName: displayName,
    storedName,
    filePath,
    mimeType: mimeType || "application/octet-stream",
    size: buffer.length,
    createdAt: new Date().toISOString(),
    source,
    shareId,
  };

  state.files.set(id, record);
  return record;
}

function saveStreamedUpload(req, { originalName, mimeType, source, shareId = null }) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const displayName = normaliseDisplayName(originalName || "file");
    const safeName = sanitizeFileName(displayName);
    const storedName = `${id}-${safeName}`;
    const filePath = path.join(uploadDir, storedName);
    const writeStream = fs.createWriteStream(filePath);
    let size = 0;
    let settled = false;

    function finishWithError(error) {
      if (settled) {
        return;
      }

      settled = true;
      writeStream.destroy();
      fsp.unlink(filePath).catch(() => {});
      reject(error);
    }

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        finishWithError(new Error("File is too large."));
        req.destroy();
      }
    });

    req.on("error", finishWithError);
    writeStream.on("error", finishWithError);

    writeStream.on("finish", () => {
      if (settled) {
        return;
      }

      settled = true;
      const record = {
        id,
        originalName: displayName,
        storedName,
        filePath,
        mimeType: mimeType || "application/octet-stream",
        size,
        createdAt: new Date().toISOString(),
        source,
        shareId,
      };

      state.files.set(id, record);
      resolve(record);
    });

    req.pipe(writeStream);
  });
}

function getUploadTarget(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const target = requestUrl.searchParams.get("target") || "inbox";
  const shareId = requestUrl.searchParams.get("shareId") || null;
  const roomCode = normaliseRoomCode(requestUrl.searchParams.get("roomCode") || "");

  if (target === "share") {
    if (!shareId || !state.shares.has(shareId)) {
      throw new Error("Share not found.");
    }
    return { target, shareId };
  }

  if (target === "room") {
    const room = state.desktopRooms.get(roomCode);
    if (!room || isRoomExpired(room)) {
      throw new Error("Room not found.");
    }
    touchRoom(room);
    return { target, shareId: null, roomCode };
  }

  return { target: "inbox", shareId: null, roomCode: null };
}

function normaliseRoomCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2);
}

function generateRoomCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let index = 0; index < 1000; index += 1) {
    const code = `${letters[Math.floor(Math.random() * letters.length)]}${Math.floor(Math.random() * 10)}`;
    const existing = state.desktopRooms.get(code);
    if (!existing || isRoomExpired(existing)) {
      return code;
    }
  }
  throw new Error("Unable to generate room code.");
}

async function deleteDesktopRoom(roomCode) {
  const room = state.desktopRooms.get(roomCode);
  if (!room) {
    return;
  }

  state.desktopRooms.delete(roomCode);
  for (const fileId of [...room.fileIds]) {
    await deleteFileRecord(fileId);
  }
}

async function handleCreateDesktopRoom(res) {
  const code = generateRoomCode();
  const now = new Date().toISOString();
  state.desktopRooms.set(code, {
    code,
    createdAt: now,
    lastSeenAt: now,
    fileIds: [],
  });

  json(res, 201, { code });
}

async function handleJoinDesktopRoom(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = normaliseRoomCode(requestUrl.searchParams.get("code") || "");
  const room = state.desktopRooms.get(code);

  if (!code || !room || isRoomExpired(room)) {
    if (room && isRoomExpired(room)) {
      await deleteDesktopRoom(code);
    }
    json(res, 404, { error: "Room not found." });
    return;
  }

  touchRoom(room);
  json(res, 200, { room: serialiseRoom(room) });
}

async function handleDesktopRoomState(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = normaliseRoomCode(requestUrl.searchParams.get("code") || "");
  const room = state.desktopRooms.get(code);

  if (!code || !room || isRoomExpired(room)) {
    if (room && isRoomExpired(room)) {
      await deleteDesktopRoom(code);
    }
    json(res, 404, { error: "Room not found." });
    return;
  }

  touchRoom(room);
  json(res, 200, { room: serialiseRoom(room) });
}

async function handleCreateClipboardRoom(res) {
  const code = generateRoomCode();
  const now = new Date().toISOString();
  state.clipboardRooms.set(code, {
    code,
    createdAt: now,
    lastSeenAt: now,
    clipboardText: "",
    clipboardUpdatedAt: null,
  });

  json(res, 201, { code });
}

async function handleJoinClipboardRoom(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = normaliseRoomCode(requestUrl.searchParams.get("code") || "");
  const room = state.clipboardRooms.get(code);

  if (!code || !room || isRoomExpired(room)) {
    if (room && isRoomExpired(room)) {
      state.clipboardRooms.delete(code);
    }
    json(res, 404, { error: "Clipboard room not found." });
    return;
  }

  touchRoom(room);
  json(res, 200, { room: serialiseClipboardRoom(room) });
}

async function handleClipboardRoomState(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = normaliseRoomCode(requestUrl.searchParams.get("code") || "");
  const room = state.clipboardRooms.get(code);

  if (!code || !room || isRoomExpired(room)) {
    if (room && isRoomExpired(room)) {
      state.clipboardRooms.delete(code);
    }
    json(res, 404, { error: "Clipboard room not found." });
    return;
  }

  touchRoom(room);
  json(res, 200, { room: serialiseClipboardRoom(room) });
}

async function handleGetPhoneClipboard(res) {
  json(res, 200, { clipboard: state.phoneClipboard });
}

async function handleUpdatePhoneClipboard(req, res) {
  try {
    const payload = await readJsonBody(req);
    const textValue = typeof payload.text === "string" ? payload.text : "";
    state.phoneClipboard = {
      text: textValue,
      updatedAt: new Date().toISOString(),
    };
    json(res, 200, { clipboard: state.phoneClipboard });
  } catch (error) {
    json(res, 400, { error: error.message || "Unable to save clipboard." });
  }
}

async function handleClearPhoneClipboard(res) {
  state.phoneClipboard = {
    text: "",
    updatedAt: new Date().toISOString(),
  };
  json(res, 200, { clipboard: state.phoneClipboard });
}

async function getClipboardRoomByRequest(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = normaliseRoomCode(requestUrl.searchParams.get("code") || "");
  const room = state.clipboardRooms.get(code);

  if (!code || !room) {
    return { code, room: null };
  }

  if (isRoomExpired(room)) {
    state.clipboardRooms.delete(code);
    return { code, room: null };
  }

  return { code, room };
}

async function handleGetDesktopClipboard(req, res) {
  const { code, room } = await getClipboardRoomByRequest(req);
  if (!code || !room) {
    json(res, 404, { error: "Clipboard room not found." });
    return;
  }

  touchRoom(room);
  json(res, 200, {
    clipboard: {
      text: room.clipboardText || "",
      updatedAt: room.clipboardUpdatedAt || null,
    },
  });
}

async function handleUpdateDesktopClipboard(req, res) {
  const { code, room } = await getClipboardRoomByRequest(req);
  if (!code || !room) {
    json(res, 404, { error: "Clipboard room not found." });
    return;
  }

  try {
    const payload = await readJsonBody(req);
    room.clipboardText = typeof payload.text === "string" ? payload.text : "";
    room.clipboardUpdatedAt = new Date().toISOString();
    touchRoom(room);
    json(res, 200, {
      clipboard: {
        text: room.clipboardText,
        updatedAt: room.clipboardUpdatedAt,
      },
    });
  } catch (error) {
    json(res, 400, { error: error.message || "Unable to save clipboard." });
  }
}

async function handleClearDesktopClipboard(req, res) {
  const { code, room } = await getClipboardRoomByRequest(req);
  if (!code || !room) {
    json(res, 404, { error: "Clipboard room not found." });
    return;
  }

  room.clipboardText = "";
  room.clipboardUpdatedAt = new Date().toISOString();
  touchRoom(room);
  json(res, 200, {
    clipboard: {
      text: room.clipboardText,
      updatedAt: room.clipboardUpdatedAt,
    },
  });
}

async function createUploadSession(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const originalName = requestUrl.searchParams.get("filename") || "upload.bin";
    const mimeType = requestUrl.searchParams.get("mimeType") || "application/octet-stream";
    const totalSize = Number(requestUrl.searchParams.get("size") || 0);
    const chunkSize = Number(requestUrl.searchParams.get("chunkSize") || 0);
    const totalChunks = Number(requestUrl.searchParams.get("totalChunks") || 0);
    const { target, shareId, roomCode } = getUploadTarget(req);

    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      json(res, 400, { error: "Invalid file size." });
      return;
    }

    if (totalSize > maxUploadBytes) {
      json(res, 400, { error: "File is too large." });
      return;
    }

    if (!Number.isFinite(chunkSize) || chunkSize <= 0 || !Number.isFinite(totalChunks) || totalChunks <= 0) {
      json(res, 400, { error: "Invalid chunk metadata." });
      return;
    }

    const sessionId = crypto.randomUUID();
    const sessionPath = path.join(chunkDir, sessionId);
    await fsp.mkdir(sessionPath, { recursive: true });

    state.uploadSessions.set(sessionId, {
      id: sessionId,
      createdAt: new Date().toISOString(),
      originalName,
      mimeType,
      totalSize,
      chunkSize,
      totalChunks,
      receivedChunks: new Set(),
      receivedBytes: 0,
      target,
      shareId,
      roomCode,
      sessionPath,
    });

    json(res, 201, { sessionId });
  } catch (error) {
    json(res, 400, { error: error.message || "Unable to create upload session." });
  }
}

async function deleteUploadSession(sessionId) {
  const session = state.uploadSessions.get(sessionId);
  if (!session) {
    return;
  }

  state.uploadSessions.delete(sessionId);
  try {
    await fsp.rm(session.sessionPath, { recursive: true, force: true });
  } catch (error) {
    console.error(`Failed to remove upload session ${sessionId}:`, error);
  }
}

async function handleUploadChunk(req, res, sessionId, chunkIndex) {
  const session = state.uploadSessions.get(sessionId);
  if (!session) {
    json(res, 404, { error: "Upload session not found." });
    return;
  }

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    json(res, 400, { error: "Invalid chunk index." });
    return;
  }

  try {
    const chunkPath = path.join(session.sessionPath, `${chunkIndex}.part`);
    const existing = session.receivedChunks.has(chunkIndex);
    const contentType = req.headers["content-type"] || "application/octet-stream";

    const record = contentType.toLowerCase().startsWith("multipart/form-data")
      ? await (async () => {
          const { buffer } = await readUploadPayload(req);
          await fsp.writeFile(chunkPath, buffer);
          return { size: buffer.length };
        })()
      : await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(chunkPath);
          let size = 0;
          let settled = false;

          function fail(error) {
            if (settled) {
              return;
            }
            settled = true;
            writeStream.destroy();
            fsp.unlink(chunkPath).catch(() => {});
            reject(error);
          }

          req.on("data", (chunk) => {
            size += chunk.length;
            if (size > session.chunkSize + 1024 * 1024) {
              fail(new Error("Chunk is too large."));
              req.destroy();
            }
          });

          req.on("error", fail);
          writeStream.on("error", fail);
          writeStream.on("finish", () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({ size });
          });
          req.pipe(writeStream);
        });

    if (!existing) {
      session.receivedChunks.add(chunkIndex);
      session.receivedBytes += record.size;
    }

    json(res, 200, {
      receivedChunks: session.receivedChunks.size,
      totalChunks: session.totalChunks,
    });
  } catch (error) {
    json(res, 400, { error: error.message || "Chunk upload failed." });
  }
}

async function handleCompleteUpload(res, sessionId) {
  const session = state.uploadSessions.get(sessionId);
  if (!session) {
    json(res, 404, { error: "Upload session not found." });
    return;
  }

  if (session.receivedChunks.size !== session.totalChunks) {
    json(res, 400, { error: "Upload is incomplete." });
    return;
  }

  try {
    const id = crypto.randomUUID();
    const displayName = normaliseDisplayName(session.originalName || "file");
    const safeName = sanitizeFileName(displayName);
    const storedName = `${id}-${safeName}`;
    const filePath = path.join(uploadDir, storedName);
    const writeStream = fs.createWriteStream(filePath);

    for (let chunkIndex = 0; chunkIndex < session.totalChunks; chunkIndex += 1) {
      const chunkPath = path.join(session.sessionPath, `${chunkIndex}.part`);
      const chunkBuffer = await fsp.readFile(chunkPath);
      writeStream.write(chunkBuffer);
    }

    await new Promise((resolve, reject) => {
      writeStream.end(resolve);
      writeStream.on("error", reject);
    });

    const record = {
      id,
      originalName: displayName,
      storedName,
      filePath,
      mimeType: session.mimeType || "application/octet-stream",
      size: session.totalSize,
      createdAt: new Date().toISOString(),
      source: session.target === "share" ? "share" : "inbox",
      shareId: session.shareId,
    };

    state.files.set(id, record);
    if (session.target === "share" && session.shareId) {
      const share = state.shares.get(session.shareId);
      if (share) {
        share.fileIds.push(record.id);
      }
    } else if (session.target === "room" && session.roomCode) {
      const room = state.desktopRooms.get(session.roomCode);
      if (room) {
        touchRoom(room);
        room.fileIds.push(record.id);
      }
    } else {
      state.inbox.unshift(record.id);
      state.inbox = state.inbox.slice(0, 100);
    }

    await deleteUploadSession(sessionId);
    json(res, 201, { file: serialiseFile(record) });
  } catch (error) {
    json(res, 500, { error: error.message || "Unable to finalize upload." });
  }
}

async function handleCreateShare(res) {
  const id = crypto.randomUUID().slice(0, 8);
  const share = {
    id,
    createdAt: new Date().toISOString(),
    fileIds: [],
  };

  state.shares.set(id, share);
  json(res, 201, {
    shareId: id,
    downloadPath: withBasePath(`/download/${id}`),
  });
}

async function handleInboxUpload(req, res) {
  try {
    const contentType = req.headers["content-type"] || "application/octet-stream";
    const originalName = new URL(req.url, `http://${req.headers.host}`).searchParams.get("filename") || "upload.bin";
    const targetInfo = getUploadTarget(req);
    const record = contentType.toLowerCase().startsWith("multipart/form-data")
      ? await (async () => {
          const { originalName: parsedName, mimeType, buffer } = await readUploadPayload(req);
          return saveUploadedFile({
            buffer,
            originalName: parsedName,
            mimeType,
            source: "inbox",
          });
        })()
      : await saveStreamedUpload(req, {
          originalName,
          mimeType: contentType,
          source: "inbox",
        });

    if (targetInfo.target === "room" && targetInfo.roomCode) {
      const room = state.desktopRooms.get(targetInfo.roomCode);
      if (room) {
        touchRoom(room);
        room.fileIds.push(record.id);
      }
    } else {
      state.inbox.unshift(record.id);
      state.inbox = state.inbox.slice(0, 100);
    }

    json(res, 201, { file: serialiseFile(record) });
  } catch (error) {
    json(res, 400, { error: error.message || "Upload failed." });
  }
}

async function handleShareUpload(req, res, shareId) {
  if (!state.shares.has(shareId)) {
    json(res, 404, { error: "Share not found." });
    return;
  }

  try {
    const contentType = req.headers["content-type"] || "application/octet-stream";
    const originalName = new URL(req.url, `http://${req.headers.host}`).searchParams.get("filename") || "upload.bin";
    const record = contentType.toLowerCase().startsWith("multipart/form-data")
      ? await (async () => {
          const { originalName: parsedName, mimeType, buffer } = await readUploadPayload(req);
          return saveUploadedFile({
            buffer,
            originalName: parsedName,
            mimeType,
            source: "share",
            shareId,
          });
        })()
      : await saveStreamedUpload(req, {
          originalName,
          mimeType: contentType,
          source: "share",
          shareId,
        });

    const share = state.shares.get(shareId);
    share.fileIds.push(record.id);
    json(res, 201, { file: serialiseFile(record) });
  } catch (error) {
    json(res, 400, { error: error.message || "Upload failed." });
  }
}

async function handleFileDownload(res, fileId) {
  const record = state.files.get(fileId);
  if (!record) {
    json(res, 404, { error: "File not found." });
    return;
  }

  if (isExpired(record)) {
    await deleteFileRecord(fileId);
    json(res, 404, { error: "File expired." });
    return;
  }

  try {
    const stat = await fsp.stat(record.filePath);
    res.writeHead(200, {
      "Content-Type": record.mimeType || "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(getDownloadName(record.originalName))}`,
    });
    fs.createReadStream(record.filePath).pipe(res);
  } catch (error) {
    json(res, 500, { error: "Unable to read file." });
  }
}

async function handleDashboardState(req, res) {
  pruneInMemoryState();
  const origin = getRequestOrigin(req);
  const latestShare = Array.from(state.shares.values()).at(-1) || null;
  const latestInbox = state.inbox
    .map((fileId) => state.files.get(fileId))
    .filter(Boolean)
    .map(serialiseFile);

  json(res, 200, {
    origin,
    basePath,
    deviceUploadPath: withBasePath("/upload"),
    clipboardTransferPath: withBasePath("/clipboard-transfer"),
    inbox: latestInbox,
    latestShare: latestShare ? serialiseShare(latestShare) : null,
    phoneClipboard: state.phoneClipboard,
  });
}

async function handleShareState(res, shareId) {
  pruneInMemoryState();
  const share = state.shares.get(shareId);
  if (!share) {
    json(res, 404, { error: "Share not found." });
    return;
  }

  json(res, 200, { share: serialiseShare(share) });
}

async function handleClearInbox(res) {
  const inboxFileIds = [...state.inbox];
  for (const fileId of inboxFileIds) {
    await deleteFileRecord(fileId);
  }

  state.inbox = [];
  json(res, 200, { ok: true });
}

async function handleClearLatestShare(res) {
  const latestShare = Array.from(state.shares.values()).at(-1) || null;
  if (!latestShare) {
    json(res, 200, { ok: true });
    return;
  }

  for (const fileId of [...latestShare.fileIds]) {
    await deleteFileRecord(fileId);
  }

  state.shares.delete(latestShare.id);
  json(res, 200, { ok: true });
}

async function handleClearDesktopRoomFiles(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const code = normaliseRoomCode(requestUrl.searchParams.get("code") || "");
  const room = state.desktopRooms.get(code);

  if (!code || !room || isRoomExpired(room)) {
    if (room && isRoomExpired(room)) {
      await deleteDesktopRoom(code);
    }
    json(res, 404, { error: "Room not found." });
    return;
  }

  for (const fileId of [...room.fileIds]) {
    await deleteFileRecord(fileId);
  }

  room.fileIds = [];
  touchRoom(room);
  json(res, 200, { ok: true });
}

async function handleQr(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const target = requestUrl.searchParams.get("text");

  if (!target) {
    json(res, 400, { error: "Missing text." });
    return;
  }

  try {
    const dataUrl = await QRCode.toDataURL(target, {
      errorCorrectionLevel: "H",
      margin: 1,
      width: 320,
      color: {
        dark: "#16324f",
        light: "#ffffff",
      },
    });
    json(res, 200, { dataUrl });
  } catch (error) {
    json(res, 500, { error: "Failed to build QR code." });
  }
}

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = stripBasePath(url.pathname);

  if (req.method === "GET" && pathname === "/") {
    serveIndex(req, res);
    return;
  }

  if (req.method === "GET" && (pathname === "/desktop-transfer" || pathname === "/phone-transfer" || pathname === "/clipboard-transfer")) {
    serveIndex(req, res);
    return;
  }

  if (req.method === "GET" && (pathname === "/upload" || pathname === "/mobile/upload")) {
    serveIndex(req, res);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/download/")) {
    serveIndex(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/styles.css") {
    serveFile(res, path.join(publicDir, "styles.css"));
    return;
  }

  if (req.method === "GET" && pathname === "/app.js") {
    serveFile(res, path.join(publicDir, "app.js"));
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    handleDashboardState(req, res);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/inbox") {
    handleClearInbox(res);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/latest-share") {
    handleClearLatestShare(res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/clipboard") {
    handleGetPhoneClipboard(res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/clipboard") {
    handleUpdatePhoneClipboard(req, res);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/clipboard") {
    handleClearPhoneClipboard(res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/desktop-rooms") {
    handleCreateDesktopRoom(res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/desktop-rooms/join") {
    handleJoinDesktopRoom(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/desktop-state") {
    handleDesktopRoomState(req, res);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/desktop-room-files") {
    handleClearDesktopRoomFiles(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/clipboard-rooms") {
    handleCreateClipboardRoom(res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/clipboard-rooms/join") {
    handleJoinClipboardRoom(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/clipboard-room-state") {
    handleClipboardRoomState(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/desktop-clipboard") {
    handleGetDesktopClipboard(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/desktop-clipboard") {
    handleUpdateDesktopClipboard(req, res);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/desktop-clipboard") {
    handleClearDesktopClipboard(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/desktop-room-bundle") {
    handleDesktopRoomBundleDownload(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/shares") {
    handleCreateShare(res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/upload-sessions") {
    createUploadSession(req, res);
    return;
  }

  if ((req.method === "PUT" || req.method === "POST") && pathname.startsWith("/api/upload-sessions/") && pathname.includes("/chunks/")) {
    const parts = pathname.split("/");
    const sessionId = parts[3];
    const chunkIndex = Number(parts[5]);
    handleUploadChunk(req, res, sessionId, chunkIndex);
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/api/upload-sessions/") && pathname.endsWith("/complete")) {
    const sessionId = pathname.split("/")[3];
    handleCompleteUpload(res, sessionId);
    return;
  }

  if ((req.method === "PUT" || req.method === "POST") && pathname === "/api/inbox-upload") {
    handleInboxUpload(req, res);
    return;
  }

  if ((req.method === "PUT" || req.method === "POST") && pathname.startsWith("/api/share-upload/")) {
    const shareId = pathname.split("/").pop();
    handleShareUpload(req, res, shareId);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/shares/")) {
    const shareId = pathname.split("/").pop();
    handleShareState(res, shareId);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/files/")) {
    const fileId = pathname.split("/").pop();
    handleFileDownload(res, fileId);
    return;
  }

  if (req.method === "GET" && pathname === "/api/qrcode") {
    handleQr(req, res);
    return;
  }

  text(res, 404, "Not found.");
}

function stripBasePath(pathname) {
  if (!basePath) {
    return pathname;
  }

  if (pathname === basePath || pathname === `${basePath}/`) {
    return "/";
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length);
  }

  return pathname;
}

async function ensureDirectories() {
  await fsp.mkdir(uploadDir, { recursive: true });
  await fsp.mkdir(chunkDir, { recursive: true });
}

function startCleanupTimer() {
  const intervalMs = Math.max(cleanupIntervalMinutes, 1) * 60 * 1000;
  const timer = setInterval(() => {
    cleanupExpiredFiles().catch((error) => {
      console.error("Failed to clean expired files:", error);
    });
  }, intervalMs);

  timer.unref();
}

async function start() {
  await ensureDirectories();
  await cleanupExpiredFiles();
  startCleanupTimer();

  const server = http.createServer(route);
  server.listen(port, host, () => {
    console.log(`file-transfer running on ${host}:${port}`);
    console.log(`Base path: ${basePath || "/"}`);
    console.log(`Max upload: ${maxUploadMb} MB`);
    console.log(`File TTL: ${fileTtlHours} hour(s)`);
    console.log(`Cleanup interval: ${cleanupIntervalMinutes} minute(s)`);
    console.log(`Desktop: http://127.0.0.1:${port}${withBasePath("/")}`);
    console.log(`LAN: http://<your-lan-ip>:${port}${withBasePath("/")}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
