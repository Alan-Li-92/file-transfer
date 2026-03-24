const app = document.querySelector("#app");
const config = window.APP_CONFIG || { basePath: "", origin: window.location.origin };
const basePath = normaliseBasePath(config.basePath || "");

function normaliseBasePath(value) {
  if (!value || value === "/") {
    return "";
  }

  return value.replace(/\/+$/g, "");
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

function stripBasePath(pathName) {
  if (!basePath) {
    return pathName;
  }

  if (pathName === basePath) {
    return "/";
  }

  return pathName.startsWith(basePath) ? pathName.slice(basePath.length) || "/" : pathName;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char];
  });
}

function buildRequestUrl(routePath, params = {}) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

  if (!query) {
    return routePath;
  }

  return `${routePath}${routePath.includes("?") ? "&" : "?"}${query}`;
}

function normaliseUploadName(fileName) {
  if (!fileName) {
    return "upload.bin";
  }

  return fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "upload.bin";
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

function formatTimestamp(value) {
  if (!value) {
    return "暂未同步";
  }

  return new Date(value).toLocaleString();
}

function setProgress(progressElements, ratio, label) {
  if (!progressElements) {
    return;
  }

  progressElements.shell.classList.add("visible");
  progressElements.bar.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  progressElements.meta.textContent = label;
}

function resetProgress(progressElements) {
  if (!progressElements) {
    return;
  }

  progressElements.shell.classList.remove("visible");
  progressElements.bar.style.width = "0%";
  progressElements.meta.textContent = "";
}

function xhrJson({ method, url, body, headers, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open(method, url, true);
    xhr.responseType = "text";

    xhr.onload = () => {
      let payload = {};

      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (error) {
        reject(new Error("Upload failed."));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }

      reject(new Error(payload.error || "Upload failed."));
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed."));
    };

    xhr.onabort = () => {
      reject(new Error("Upload aborted."));
    };

    xhr.ontimeout = () => {
      reject(new Error("Upload timed out."));
    };

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = onProgress;
    }

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (value) {
          xhr.setRequestHeader(key, value);
        }
      }
    }

    xhr.send(body);
  });
}

async function uploadSingleFile(file, url, onProgress, uploadName = file.name) {
  const safeName = normaliseUploadName(uploadName);
  const chunkSize = 8 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const targetUrl = new URL(url, window.location.origin);
  const targetInfo = targetUrl.pathname.includes("/api/share-upload/")
    ? {
        target: "share",
        shareId: targetUrl.pathname.split("/").pop(),
      }
    : {
        target: targetUrl.searchParams.get("target") || "inbox",
        roomCode: targetUrl.searchParams.get("roomCode") || "",
      };

  const sessionUrl = buildRequestUrl(withBasePath("/api/upload-sessions"), {
    filename: safeName,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    chunkSize,
    totalChunks,
    ...targetInfo,
  });

  const sessionPayload = await fetchJson(sessionUrl, { method: "POST" });
  let uploadedBytes = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const chunk = file.slice(start, end);

    await xhrJson({
      method: "PUT",
      url: withBasePath(`/api/upload-sessions/${sessionPayload.sessionId}/chunks/${chunkIndex}`),
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
      body: chunk,
      onProgress: (event) => {
        if (!onProgress) {
          return;
        }

        const currentUploaded = uploadedBytes + (event.lengthComputable ? event.loaded : 0);
        onProgress(currentUploaded, file.size, file.name);
      },
    });

    uploadedBytes = end;
    if (onProgress) {
      onProgress(uploadedBytes, file.size, file.name);
    }
  }

  return fetchJson(withBasePath(`/api/upload-sessions/${sessionPayload.sessionId}/complete`), {
    method: "POST",
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

async function buildQrDataUrl(text) {
  const payload = await fetchJson(`${withBasePath("/api/qrcode")}?text=${encodeURIComponent(text)}`);
  return payload.dataUrl;
}

function fileItemTemplate(file) {
  return `
    <div class="file-item">
      <div>
        <div class="file-name">${escapeHtml(file.originalName)}</div>
        <div class="file-meta">${file.sizeLabel} · ${new Date(file.createdAt).toLocaleString()}</div>
      </div>
      <a class="button-link secondary" href="${file.downloadPath}">下载</a>
    </div>
  `;
}

function roomEntryTemplate(entry) {
  if (entry.kind === "folder") {
    return `
      <div class="file-item">
        <div>
          <div class="file-name">${escapeHtml(entry.name)}/</div>
          <div class="file-meta">${entry.fileCount} 个文件 · ${entry.sizeLabel}</div>
        </div>
        <a class="button-link secondary" href="${entry.downloadPath}">下载文件夹</a>
      </div>
    `;
  }

  return fileItemTemplate(entry);
}

function buildRoomEntries(roomCode, files) {
  const folders = new Map();
  const entries = [];

  for (const file of files) {
    if (!file.originalName.includes("/")) {
      entries.push(file);
      continue;
    }

    const folder = file.originalName.split("/")[0];
    if (!folders.has(folder)) {
      folders.set(folder, {
        kind: "folder",
        name: folder,
        fileCount: 0,
        totalSize: 0,
        downloadPath: buildRequestUrl(withBasePath("/api/desktop-room-bundle"), {
          code: roomCode,
          folder,
        }),
      });
    }

    const entry = folders.get(folder);
    entry.fileCount += 1;
    entry.totalSize += file.size;
  }

  const folderEntries = Array.from(folders.values()).map((entry) => ({
    ...entry,
    sizeLabel: formatBytes(entry.totalSize),
  }));

  return [...folderEntries, ...entries];
}

async function uploadFiles(files, url, onStatus, onProgress) {
  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  let completedBytes = 0;

  for (const item of files) {
    onStatus(`正在上传 ${item.uploadName}...`);
    await uploadSingleFile(item.file, url, (currentFileBytes, fileTotalBytes, fileName) => {
      if (!onProgress) {
        return;
      }

      onProgress(completedBytes + currentFileBytes, totalBytes, fileName, fileTotalBytes);
    }, item.uploadName);
    completedBytes += item.file.size;
    if (onProgress) {
      onProgress(completedBytes, totalBytes, item.uploadName, item.file.size);
    }
  }
}

function buildProgressElements(rootSelector) {
  const shell = document.querySelector(rootSelector);
  return {
    shell,
    bar: document.querySelector(`${rootSelector} .progress-bar`),
    meta: document.querySelector(`${rootSelector} .progress-meta`),
  };
}

function renderClipboardPreview(target, clipboard, emptyText) {
  if (!target) {
    return;
  }

  if (!clipboard?.text) {
    target.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }

  target.innerHTML = `
    <div class="clipboard-meta">最后更新：${escapeHtml(formatTimestamp(clipboard.updatedAt))}</div>
    <pre class="clipboard-preview"></pre>
  `;
  target.querySelector(".clipboard-preview").textContent = clipboard.text;
}

function syncClipboardEditor(editor, clipboard, lastSyncedText) {
  const incomingText = clipboard?.text || "";
  if (editor && (!editor.value || editor.value === lastSyncedText)) {
    editor.value = incomingText;
  }
  return incomingText;
}

function getStoredDesktopCode() {
  return window.localStorage.getItem("file-transfer-desktop-code") || "";
}

function setStoredDesktopCode(code) {
  window.localStorage.setItem("file-transfer-desktop-code", code);
}

function clearStoredDesktopCode() {
  window.localStorage.removeItem("file-transfer-desktop-code");
}

function getStoredClipboardCode() {
  return window.localStorage.getItem("file-transfer-clipboard-code") || "";
}

function setStoredClipboardCode(code) {
  window.localStorage.setItem("file-transfer-clipboard-code", code);
}

function clearStoredClipboardCode() {
  window.localStorage.removeItem("file-transfer-clipboard-code");
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
}

function collectUploadItems(...fileLists) {
  return fileLists.flatMap((fileList) =>
    Array.from(fileList || []).map((file) => ({
      file,
      uploadName: file.webkitRelativePath || file.name,
    }))
  );
}

function updatePickerSummary(target, items, emptyText) {
  if (!target) {
    return;
  }

  if (!items.length) {
    target.textContent = emptyText;
    return;
  }

  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  target.textContent = `已选 ${items.length} 项 · ${formatBytes(totalBytes)}`;
}

function renderModeSelector() {
  app.innerHTML = `
    <section class="mode-grid">
      <a class="card mode-card" href="${withBasePath("/desktop-transfer")}">
        <div class="mode-tag">Desktop to Desktop</div>
        <h2>电脑和电脑互传</h2>
        <p>A 和 B 都打开这个模式后，谁上传都可以，双方都会看到同一份文件列表，不需要区分发送端和接收端。</p>
      </a>
      <a class="card mode-card" href="${withBasePath("/phone-transfer")}">
        <div class="mode-tag">Desktop to Phone</div>
        <h2>电脑和手机互传</h2>
        <p>保留二维码上传、电脑发手机、手机下载二维码这些流程，适合电脑和 iPhone 之间互传文件。</p>
      </a>
      <a class="card mode-card" href="${withBasePath("/clipboard-transfer")}">
        <div class="mode-tag">Clipboard</div>
        <h2>跨设备剪贴板</h2>
        <p>专门解决电脑和电脑、电脑和手机之间的文本复制粘贴，保留原始换行和缩进，适合代码和命令。</p>
      </a>
    </section>
  `;
}

async function renderPhoneTransfer() {
  app.innerHTML = `
    <section class="dashboard">
      <article class="card">
        <h2>设备投递到这里</h2>
        <p>手机可以扫码打开投递页，另一台电脑也可以直接打开这个链接上传文件。上传完成后右侧列表会自动刷新。</p>
        <div id="uploadQr" class="qr-wrap"><div class="subtle">二维码生成中...</div></div>
        <div id="uploadUrl" class="url-box subtle"></div>
        <div class="actions">
          <a id="openUploadPage" class="button-link secondary" href="#">在当前电脑打开投递页</a>
        </div>
      </article>
      <article class="card">
        <h2>接收列表</h2>
        <p>B 电脑打开这个主页后，就能下载 A 电脑或手机刚刚投递过来的文件。</p>
        <div class="actions">
          <button id="clearInbox" class="secondary">清理接收列表</button>
        </div>
        <div id="inboxList" class="file-list"></div>
      </article>
      <article class="card">
        <h2>电脑发送到手机</h2>
        <p>先在这里选中文件，上传成功后会生成一个新的下载二维码，iPhone 扫码即可下载。</p>
        <input id="shareFiles" type="file" multiple />
        <div class="actions">
          <button id="shareSubmit">上传并生成二维码</button>
        </div>
        <div id="shareStatus" class="status"></div>
        <div id="shareProgress" class="progress-shell">
          <div class="progress-track"><div class="progress-bar"></div></div>
          <div class="progress-meta"></div>
        </div>
      </article>
      <article class="card">
        <h2>手机下载二维码</h2>
        <p>每次电脑上传完文件，这里都会更新为新的下载页二维码。</p>
        <div class="actions">
          <button id="clearLatestShare" class="secondary">清理手机下载列表</button>
        </div>
        <div id="shareQr" class="qr-wrap"><div class="subtle">先上传电脑里的文件</div></div>
        <div id="shareUrl" class="url-box subtle">等待生成下载链接...</div>
        <div id="shareFilesList" class="file-list"></div>
      </article>
    </section>
  `;

  const uploadQr = document.querySelector("#uploadQr");
  const uploadUrl = document.querySelector("#uploadUrl");
  const openUploadPage = document.querySelector("#openUploadPage");
  const clearInbox = document.querySelector("#clearInbox");
  const inboxList = document.querySelector("#inboxList");
  const shareFilesInput = document.querySelector("#shareFiles");
  const shareSubmit = document.querySelector("#shareSubmit");
  const shareStatus = document.querySelector("#shareStatus");
  const shareProgress = buildProgressElements("#shareProgress");
  const clearLatestShare = document.querySelector("#clearLatestShare");
  const shareQr = document.querySelector("#shareQr");
  const shareUrl = document.querySelector("#shareUrl");
  const shareFilesList = document.querySelector("#shareFilesList");

  async function refreshDashboard() {
    const payload = await fetchJson(withBasePath("/api/state"));
    const deviceUploadUrl = `${payload.origin}${payload.deviceUploadPath}`;
    const uploadQrData = await buildQrDataUrl(deviceUploadUrl);

    uploadQr.innerHTML = `<img alt="Upload QR code" src="${uploadQrData}" />`;
    uploadUrl.textContent = deviceUploadUrl;
    openUploadPage.href = payload.deviceUploadPath;

    inboxList.innerHTML = payload.inbox.length
      ? payload.inbox.map(fileItemTemplate).join("")
      : `<div class="empty">手机或另一台电脑投递的文件会出现在这里。</div>`;

    if (payload.latestShare) {
      const fullShareUrl = `${payload.origin}${payload.latestShare.downloadPath}`;
      const shareQrData = await buildQrDataUrl(fullShareUrl);
      shareQr.innerHTML = `<img alt="Share QR code" src="${shareQrData}" />`;
      shareUrl.textContent = fullShareUrl;
      shareFilesList.innerHTML = payload.latestShare.files.length
        ? payload.latestShare.files.map(fileItemTemplate).join("")
        : `<div class="empty">这个分享链接里还没有文件。</div>`;
    } else {
      shareQr.innerHTML = `<div class="subtle">先上传电脑里的文件</div>`;
      shareUrl.textContent = "等待生成下载链接...";
      shareFilesList.innerHTML = `<div class="empty">这个分享链接里还没有文件。</div>`;
    }
  }

  clearInbox.addEventListener("click", async () => {
    try {
      await fetchJson(withBasePath("/api/inbox"), { method: "DELETE" });
      shareStatus.textContent = "接收列表已清理。";
      shareStatus.classList.remove("error");
      await refreshDashboard();
    } catch (error) {
      shareStatus.textContent = error.message || "清理接收列表失败。";
      shareStatus.classList.add("error");
    }
  });

  clearLatestShare.addEventListener("click", async () => {
    try {
      await fetchJson(withBasePath("/api/latest-share"), { method: "DELETE" });
      shareStatus.textContent = "手机下载列表已清理。";
      shareStatus.classList.remove("error");
      await refreshDashboard();
    } catch (error) {
      shareStatus.textContent = error.message || "清理手机下载列表失败。";
      shareStatus.classList.add("error");
    }
  });

  shareSubmit.addEventListener("click", async () => {
    const items = collectUploadItems(shareFilesInput.files);
    if (!items.length) {
      shareStatus.textContent = "请先选择至少一个文件。";
      shareStatus.classList.add("error");
      return;
    }

    shareStatus.classList.remove("error");
    resetProgress(shareProgress);

    try {
      const sharePayload = await fetchJson(withBasePath("/api/shares"), { method: "POST" });
      await uploadFiles(
        items,
        withBasePath(`/api/share-upload/${sharePayload.shareId}`),
        (message) => {
          shareStatus.textContent = message;
        },
        (sentBytes, totalBytes, fileName) => {
          setProgress(
            shareProgress,
            totalBytes ? sentBytes / totalBytes : 0,
            `${fileName} · ${formatBytes(sentBytes)} / ${formatBytes(totalBytes)}`
          );
        }
      );
      shareStatus.textContent = "上传完成，二维码已更新。";
      shareFilesInput.value = "";
      setProgress(shareProgress, 1, `已完成 · ${formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))}`);
      await refreshDashboard();
    } catch (error) {
      shareStatus.textContent = error.message;
      shareStatus.classList.add("error");
    }
  });

  await refreshDashboard();
  window.setInterval(() => {
    refreshDashboard().catch(() => {});
  }, 4000);
}

async function renderDesktopTransfer() {
  let currentCode = getStoredDesktopCode();
  let refreshTimer = null;

  function clearTimer() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function renderPairView(errorMessage = "") {
    clearTimer();
    app.innerHTML = `
      <section class="desktop-layout">
        <article class="card">
          <h2>电脑互传先对码</h2>
          <p>先生成或输入一个两位口令。只有口令一致的电脑，才会看到同一个共享文件列表。</p>
          <input id="desktopCodeInput" type="text" maxlength="2" placeholder="例如 A7" />
          <div class="actions">
            <button id="desktopCreateCode">生成随机口令</button>
            <button id="desktopJoinCode" class="secondary">加入这个口令</button>
            <a class="button-link secondary" href="${withBasePath("/")}">返回模式选择</a>
          </div>
          <div id="desktopPairStatus" class="status ${errorMessage ? "error" : ""}">${errorMessage || "等待生成或输入口令。"}</div>
        </article>
      </section>
    `;

    const createButton = document.querySelector("#desktopCreateCode");
    const joinButton = document.querySelector("#desktopJoinCode");
    const codeInput = document.querySelector("#desktopCodeInput");
    const pairStatus = document.querySelector("#desktopPairStatus");

    if (currentCode) {
      codeInput.value = currentCode;
    }

    createButton.addEventListener("click", async () => {
      try {
        const payload = await fetchJson(withBasePath("/api/desktop-rooms"), { method: "POST" });
        currentCode = payload.code;
        setStoredDesktopCode(currentCode);
        await renderWorkspace();
      } catch (error) {
        pairStatus.textContent = error.message || "生成口令失败。";
        pairStatus.classList.add("error");
      }
    });

    joinButton.addEventListener("click", async () => {
      const code = codeInput.value.trim().toUpperCase();
      if (!code) {
        pairStatus.textContent = "请先输入口令。";
        pairStatus.classList.add("error");
        return;
      }

      try {
        await fetchJson(buildRequestUrl(withBasePath("/api/desktop-rooms/join"), { code }), { method: "POST" });
        currentCode = code;
        setStoredDesktopCode(currentCode);
        await renderWorkspace();
      } catch (error) {
        pairStatus.textContent = "口令不存在，或已经失效。";
        pairStatus.classList.add("error");
      }
    });
  }

  async function fetchRoomState() {
    return fetchJson(buildRequestUrl(withBasePath("/api/desktop-state"), { code: currentCode }));
  }

  async function renderWorkspace() {
    app.innerHTML = `
      <section class="desktop-layout">
        <article class="card">
          <h2>电脑互传工作台</h2>
          <p>只有输入相同口令的电脑，才会共享下面这份文件列表。只要每天有人打开，这个口令就会继续有效。浏览器选择文件夹时出现的安全提示来自浏览器本身，网页不能关闭。</p>
          <div class="code-banner">
            <div>
              <div class="code-label">当前口令</div>
              <div class="code-value" id="desktopRoomCode">${escapeHtml(currentCode)}</div>
            </div>
            <button id="desktopCopyCode" class="secondary">复制口令</button>
          </div>
          <div class="picker-row">
            <label class="picker-button" for="desktopFiles">选择文件</label>
            <label class="picker-button" for="desktopFolders">选择文件夹</label>
          </div>
          <input id="desktopFiles" class="visually-hidden-input" type="file" multiple />
          <input id="desktopFolders" class="visually-hidden-input" type="file" webkitdirectory directory multiple />
          <div id="desktopPickerSummary" class="picker-summary">暂未选择文件或文件夹。</div>
          <div class="actions">
            <button id="desktopSubmit">上传到共享列表</button>
            <button id="desktopLeave" class="secondary">重新对码</button>
            <a class="button-link secondary" href="${withBasePath("/")}">返回模式选择</a>
          </div>
          <div id="desktopStatus" class="status"></div>
          <div id="desktopProgress" class="progress-shell">
            <div class="progress-track"><div class="progress-bar"></div></div>
            <div class="progress-meta"></div>
          </div>
        </article>
        <article class="card">
          <h2>共享文件列表</h2>
          <p>只有口令对上的电脑，才会看到这里的文件。</p>
          <div class="actions">
            <button id="desktopClearFiles" class="secondary">清理共享列表</button>
          </div>
          <div id="desktopInboxList" class="file-list"></div>
        </article>
      </section>
    `;

    const desktopFiles = document.querySelector("#desktopFiles");
    const desktopFolders = document.querySelector("#desktopFolders");
    const desktopSubmit = document.querySelector("#desktopSubmit");
    const desktopLeave = document.querySelector("#desktopLeave");
    const desktopCopyCode = document.querySelector("#desktopCopyCode");
    const desktopStatus = document.querySelector("#desktopStatus");
    const desktopProgress = buildProgressElements("#desktopProgress");
    const desktopClearFiles = document.querySelector("#desktopClearFiles");
    const desktopInboxList = document.querySelector("#desktopInboxList");
    const desktopPickerSummary = document.querySelector("#desktopPickerSummary");

    async function refreshDesktopInbox() {
      try {
        const payload = await fetchRoomState();
        const roomEntries = buildRoomEntries(currentCode, payload.room.files);
        desktopInboxList.innerHTML = roomEntries.length
          ? roomEntries.map(roomEntryTemplate).join("")
          : `<div class="empty">这个口令下还没有文件。</div>`;
      } catch (error) {
        clearStoredDesktopCode();
        currentCode = "";
        await renderPairView("口令已失效，请重新对码。");
      }
    }

    desktopLeave.addEventListener("click", () => {
      clearStoredDesktopCode();
      currentCode = "";
      renderPairView();
    });

    function refreshPickerSummary() {
      updatePickerSummary(
        desktopPickerSummary,
        collectUploadItems(desktopFiles.files, desktopFolders.files),
        "暂未选择文件或文件夹。"
      );
    }

    desktopFiles.addEventListener("change", refreshPickerSummary);
    desktopFolders.addEventListener("change", refreshPickerSummary);

    desktopCopyCode.addEventListener("click", async () => {
      try {
        await copyText(currentCode);
        desktopStatus.textContent = `口令 ${currentCode} 已复制。`;
        desktopStatus.classList.remove("error");
      } catch (error) {
        desktopStatus.textContent = "复制口令失败，请手动记录。";
        desktopStatus.classList.add("error");
      }
    });

    desktopClearFiles.addEventListener("click", async () => {
      try {
        await fetchJson(buildRequestUrl(withBasePath("/api/desktop-room-files"), { code: currentCode }), {
          method: "DELETE",
        });
        desktopStatus.textContent = "共享文件列表已清理。";
        desktopStatus.classList.remove("error");
        await refreshDesktopInbox();
      } catch (error) {
        desktopStatus.textContent = error.message || "清理共享列表失败。";
        desktopStatus.classList.add("error");
      }
    });

    desktopSubmit.addEventListener("click", async () => {
      const items = collectUploadItems(desktopFiles.files, desktopFolders.files);
      if (!items.length) {
        desktopStatus.textContent = "请先选择文件或目录。";
        desktopStatus.classList.add("error");
        return;
      }

      desktopStatus.classList.remove("error");
      resetProgress(desktopProgress);

      try {
        await uploadFiles(
          items,
          buildRequestUrl(withBasePath("/api/inbox-upload"), {
            target: "room",
            roomCode: currentCode,
          }),
          (message) => {
            desktopStatus.textContent = message;
          },
          (sentBytes, totalBytes, fileName) => {
            setProgress(
              desktopProgress,
              totalBytes ? sentBytes / totalBytes : 0,
              `${fileName} · ${formatBytes(sentBytes)} / ${formatBytes(totalBytes)}`
            );
          }
        );
        desktopStatus.textContent = "上传完成，共享列表已更新。";
        desktopFiles.value = "";
        desktopFolders.value = "";
        refreshPickerSummary();
        setProgress(desktopProgress, 1, `已完成 · ${formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))}`);
        await refreshDesktopInbox();
      } catch (error) {
        desktopStatus.textContent = error.message || "Upload failed.";
        desktopStatus.classList.add("error");
      }
    });

    await refreshDesktopInbox();
    clearTimer();
    refreshTimer = window.setInterval(() => {
      refreshDesktopInbox().catch(() => {});
    }, 4000);
  }

  if (currentCode) {
    try {
      await fetchJson(buildRequestUrl(withBasePath("/api/desktop-rooms/join"), { code: currentCode }), { method: "POST" });
      await renderWorkspace();
      return;
    } catch (error) {
      clearStoredDesktopCode();
      currentCode = "";
    }
  }

  renderPairView();
}

async function renderDeviceUpload() {
  app.innerHTML = `
    <section class="mobile-layout">
      <article class="card">
        <h2>投递文件</h2>
        <p>这个页面既可以给 iPhone 用，也可以在另一台电脑上打开。上传后接收端主页会自动刷新列表。</p>
        <input id="mobileFiles" type="file" multiple />
        <div class="actions">
          <button id="mobileSubmit">开始上传</button>
          <a class="button-link secondary" href="${withBasePath("/")}">返回首页</a>
        </div>
        <div id="mobileStatus" class="status"></div>
        <div id="mobileProgress" class="progress-shell">
          <div class="progress-track"><div class="progress-bar"></div></div>
          <div class="progress-meta"></div>
        </div>
      </article>
    </section>
  `;

  const mobileFiles = document.querySelector("#mobileFiles");
  const mobileSubmit = document.querySelector("#mobileSubmit");
  const mobileStatus = document.querySelector("#mobileStatus");
  const mobileProgress = buildProgressElements("#mobileProgress");

  mobileSubmit.addEventListener("click", async () => {
    const items = collectUploadItems(mobileFiles.files);
    if (!items.length) {
      mobileStatus.textContent = "请先选择文件。";
      mobileStatus.classList.add("error");
      return;
    }

    mobileStatus.classList.remove("error");
    resetProgress(mobileProgress);

    try {
      await uploadFiles(
        items,
        withBasePath("/api/inbox-upload"),
        (message) => {
          mobileStatus.textContent = message;
        },
        (sentBytes, totalBytes, fileName) => {
          setProgress(
            mobileProgress,
            totalBytes ? sentBytes / totalBytes : 0,
            `${fileName} · ${formatBytes(sentBytes)} / ${formatBytes(totalBytes)}`
          );
        }
      );
      mobileStatus.textContent = "上传完成，现在回电脑页面就能下载。";
      mobileFiles.value = "";
      setProgress(mobileProgress, 1, `已完成 · ${formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))}`);
    } catch (error) {
      mobileStatus.textContent = error.message || "Upload failed.";
      mobileStatus.classList.add("error");
    }
  });
}

async function renderClipboardTransfer() {
  let currentCode = getStoredClipboardCode();
  let refreshTimer = null;

  function clearTimer() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function renderPairView(errorMessage = "") {
    clearTimer();
    app.innerHTML = `
      <section class="desktop-layout">
        <article class="card">
          <h2>电脑和电脑先对码</h2>
          <p>电脑和电脑之间可以输入同一个两位口令，进入同一块共享文本板。内容保留原始格式，适合代码和命令。</p>
          <input id="clipboardCodeInput" type="text" maxlength="2" placeholder="例如 A7" />
          <div class="actions">
            <button id="clipboardCreateCode">生成随机口令</button>
            <button id="clipboardJoinCode" class="secondary">加入这个口令</button>
            <a class="button-link secondary" href="${withBasePath("/")}">返回模式选择</a>
          </div>
          <div id="clipboardPairStatus" class="status ${errorMessage ? "error" : ""}">${errorMessage || "等待生成或输入口令。"}</div>
        </article>
        <article class="card">
          <h2>电脑和手机直接共享</h2>
          <p>手机扫描下面的二维码后，就能打开同一个跨设备剪贴板页面，不需要先对码。</p>
          <div id="globalClipboardQr" class="qr-wrap"><div class="subtle">二维码生成中...</div></div>
          <div id="globalClipboardUrl" class="url-box subtle"></div>
        </article>
      </section>
    `;

    const createButton = document.querySelector("#clipboardCreateCode");
    const joinButton = document.querySelector("#clipboardJoinCode");
    const codeInput = document.querySelector("#clipboardCodeInput");
    const pairStatus = document.querySelector("#clipboardPairStatus");
    const globalClipboardQr = document.querySelector("#globalClipboardQr");
    const globalClipboardUrl = document.querySelector("#globalClipboardUrl");

    if (currentCode) {
      codeInput.value = currentCode;
    }

    fetchJson(withBasePath("/api/state"))
      .then(async (payload) => {
        const url = `${payload.origin}${payload.clipboardTransferPath}`;
        const qr = await buildQrDataUrl(url);
        globalClipboardQr.innerHTML = `<img alt="Clipboard QR code" src="${qr}" />`;
        globalClipboardUrl.textContent = url;
      })
      .catch(() => {
        globalClipboardUrl.textContent = "二维码暂时生成失败。";
      });

    createButton.addEventListener("click", async () => {
      try {
        const payload = await fetchJson(withBasePath("/api/clipboard-rooms"), { method: "POST" });
        currentCode = payload.code;
        setStoredClipboardCode(currentCode);
        await renderWorkspace();
      } catch (error) {
        pairStatus.textContent = error.message || "生成口令失败。";
        pairStatus.classList.add("error");
      }
    });

    joinButton.addEventListener("click", async () => {
      const code = codeInput.value.trim().toUpperCase();
      if (!code) {
        pairStatus.textContent = "请先输入口令。";
        pairStatus.classList.add("error");
        return;
      }

      try {
        await fetchJson(buildRequestUrl(withBasePath("/api/clipboard-rooms/join"), { code }), { method: "POST" });
        currentCode = code;
        setStoredClipboardCode(currentCode);
        await renderWorkspace();
      } catch (error) {
        pairStatus.textContent = "口令不存在，或已经失效。";
        pairStatus.classList.add("error");
      }
    });
  }

  async function fetchClipboardRoomState() {
    return fetchJson(buildRequestUrl(withBasePath("/api/clipboard-room-state"), { code: currentCode }));
  }

  async function renderWorkspace() {
    app.innerHTML = `
      <section class="desktop-layout">
        <div class="desktop-main-column">
          <article class="card">
            <h2>电脑和电脑共享剪贴板</h2>
            <p>两台电脑输入同一个口令后，就共享下面这块文本板。只要每天有人打开，这个口令就会继续有效。</p>
            <div class="code-banner">
              <div>
                <div class="code-label">当前口令</div>
                <div class="code-value">${escapeHtml(currentCode)}</div>
              </div>
              <button id="clipboardCopyCode" class="secondary">复制口令</button>
            </div>
            <textarea id="desktopClipboardEditor" class="clipboard-editor" spellcheck="false" placeholder="把内容粘贴到这里，点击保存后，另一台电脑会立刻看到。"></textarea>
            <div class="actions">
              <button id="desktopClipboardSave">保存文本</button>
              <button id="desktopClipboardCopy" class="secondary">复制当前文本</button>
              <button id="desktopClipboardClear" class="secondary">清理文本</button>
              <button id="clipboardLeave" class="secondary">重新对码</button>
            </div>
            <div id="desktopClipboardStatus" class="status"></div>
          </article>
          <article class="card">
            <h2>当前文本预览</h2>
            <p>这里会按原始格式显示当前共享文本，方便确认代码缩进和换行。</p>
            <div id="desktopClipboardPreview" class="clipboard-shell"></div>
          </article>
        </div>
        <article class="card">
          <h2>电脑和手机跨设备剪贴板</h2>
          <p>手机扫描下面的二维码后，就能打开同一个跨设备文本板。这个入口不需要口令，适合电脑和手机快速复制粘贴。</p>
          <div id="phoneClipboardQr" class="qr-wrap"><div class="subtle">二维码生成中...</div></div>
          <div id="phoneClipboardUrl" class="url-box subtle"></div>
          <textarea id="phoneClipboardEditor" class="clipboard-editor" spellcheck="false" placeholder="这里是电脑和手机共享的文本板。"></textarea>
          <div class="actions">
            <button id="phoneClipboardSave">保存文本</button>
            <button id="phoneClipboardCopy" class="secondary">复制当前文本</button>
            <button id="phoneClipboardClear" class="secondary">清理文本</button>
          </div>
          <div id="phoneClipboardStatus" class="status"></div>
          <div id="phoneClipboardPreview" class="clipboard-shell"></div>
        </article>
      </section>
    `;

    const clipboardCopyCode = document.querySelector("#clipboardCopyCode");
    const clipboardLeave = document.querySelector("#clipboardLeave");
    const desktopClipboardEditor = document.querySelector("#desktopClipboardEditor");
    const desktopClipboardSave = document.querySelector("#desktopClipboardSave");
    const desktopClipboardCopy = document.querySelector("#desktopClipboardCopy");
    const desktopClipboardClear = document.querySelector("#desktopClipboardClear");
    const desktopClipboardStatus = document.querySelector("#desktopClipboardStatus");
    const desktopClipboardPreview = document.querySelector("#desktopClipboardPreview");
    const phoneClipboardQr = document.querySelector("#phoneClipboardQr");
    const phoneClipboardUrl = document.querySelector("#phoneClipboardUrl");
    const phoneClipboardEditor = document.querySelector("#phoneClipboardEditor");
    const phoneClipboardSave = document.querySelector("#phoneClipboardSave");
    const phoneClipboardCopy = document.querySelector("#phoneClipboardCopy");
    const phoneClipboardClear = document.querySelector("#phoneClipboardClear");
    const phoneClipboardStatus = document.querySelector("#phoneClipboardStatus");
    const phoneClipboardPreview = document.querySelector("#phoneClipboardPreview");
    let lastDesktopClipboardText = "";
    let lastPhoneClipboardText = "";

    async function refreshClipboards() {
      try {
        const [desktopPayload, globalPayload, dashboardPayload] = await Promise.all([
          fetchClipboardRoomState(),
          fetchJson(withBasePath("/api/clipboard")),
          fetchJson(withBasePath("/api/state")),
        ]);

        lastDesktopClipboardText = syncClipboardEditor(desktopClipboardEditor, desktopPayload.room.clipboard, lastDesktopClipboardText);
        renderClipboardPreview(desktopClipboardPreview, desktopPayload.room.clipboard, "这个口令下还没有共享文本。");

        lastPhoneClipboardText = syncClipboardEditor(phoneClipboardEditor, globalPayload.clipboard, lastPhoneClipboardText);
        renderClipboardPreview(phoneClipboardPreview, globalPayload.clipboard, "这里会显示电脑和手机共享的文本内容。");

        const globalUrl = `${dashboardPayload.origin}${dashboardPayload.clipboardTransferPath}`;
        phoneClipboardUrl.textContent = globalUrl;
        const qr = await buildQrDataUrl(globalUrl);
        phoneClipboardQr.innerHTML = `<img alt="Clipboard QR code" src="${qr}" />`;
      } catch (error) {
        clearStoredClipboardCode();
        currentCode = "";
        await renderPairView("口令已失效，请重新对码。");
      }
    }

    clipboardCopyCode.addEventListener("click", async () => {
      try {
        await copyText(currentCode);
        desktopClipboardStatus.textContent = `口令 ${currentCode} 已复制。`;
        desktopClipboardStatus.classList.remove("error");
      } catch (error) {
        desktopClipboardStatus.textContent = "复制口令失败，请手动记录。";
        desktopClipboardStatus.classList.add("error");
      }
    });

    clipboardLeave.addEventListener("click", () => {
      clearStoredClipboardCode();
      currentCode = "";
      renderPairView();
    });

    desktopClipboardSave.addEventListener("click", async () => {
      try {
        const payload = await fetchJson(buildRequestUrl(withBasePath("/api/desktop-clipboard"), { code: currentCode }), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: desktopClipboardEditor.value }),
        });
        lastDesktopClipboardText = syncClipboardEditor(desktopClipboardEditor, payload.clipboard, lastDesktopClipboardText);
        renderClipboardPreview(desktopClipboardPreview, payload.clipboard, "这个口令下还没有共享文本。");
        desktopClipboardStatus.textContent = "共享文本已保存。";
        desktopClipboardStatus.classList.remove("error");
      } catch (error) {
        desktopClipboardStatus.textContent = error.message || "保存文本失败。";
        desktopClipboardStatus.classList.add("error");
      }
    });

    desktopClipboardCopy.addEventListener("click", async () => {
      try {
        await copyText(desktopClipboardEditor.value);
        desktopClipboardStatus.textContent = "当前文本已复制。";
        desktopClipboardStatus.classList.remove("error");
      } catch (error) {
        desktopClipboardStatus.textContent = "复制失败，请手动选择文本。";
        desktopClipboardStatus.classList.add("error");
      }
    });

    desktopClipboardClear.addEventListener("click", async () => {
      try {
        const payload = await fetchJson(buildRequestUrl(withBasePath("/api/desktop-clipboard"), { code: currentCode }), {
          method: "DELETE",
        });
        desktopClipboardEditor.value = "";
        lastDesktopClipboardText = syncClipboardEditor(desktopClipboardEditor, payload.clipboard, "");
        renderClipboardPreview(desktopClipboardPreview, payload.clipboard, "这个口令下还没有共享文本。");
        desktopClipboardStatus.textContent = "共享文本已清理。";
        desktopClipboardStatus.classList.remove("error");
      } catch (error) {
        desktopClipboardStatus.textContent = error.message || "清理失败。";
        desktopClipboardStatus.classList.add("error");
      }
    });

    phoneClipboardSave.addEventListener("click", async () => {
      try {
        const payload = await fetchJson(withBasePath("/api/clipboard"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: phoneClipboardEditor.value }),
        });
        lastPhoneClipboardText = syncClipboardEditor(phoneClipboardEditor, payload.clipboard, lastPhoneClipboardText);
        renderClipboardPreview(phoneClipboardPreview, payload.clipboard, "这里会显示电脑和手机共享的文本内容。");
        phoneClipboardStatus.textContent = "跨设备文本已保存。";
        phoneClipboardStatus.classList.remove("error");
      } catch (error) {
        phoneClipboardStatus.textContent = error.message || "保存文本失败。";
        phoneClipboardStatus.classList.add("error");
      }
    });

    phoneClipboardCopy.addEventListener("click", async () => {
      try {
        await copyText(phoneClipboardEditor.value);
        phoneClipboardStatus.textContent = "当前文本已复制。";
        phoneClipboardStatus.classList.remove("error");
      } catch (error) {
        phoneClipboardStatus.textContent = "复制失败，请手动选择文本。";
        phoneClipboardStatus.classList.add("error");
      }
    });

    phoneClipboardClear.addEventListener("click", async () => {
      try {
        const payload = await fetchJson(withBasePath("/api/clipboard"), { method: "DELETE" });
        phoneClipboardEditor.value = "";
        lastPhoneClipboardText = syncClipboardEditor(phoneClipboardEditor, payload.clipboard, "");
        renderClipboardPreview(phoneClipboardPreview, payload.clipboard, "这里会显示电脑和手机共享的文本内容。");
        phoneClipboardStatus.textContent = "跨设备文本已清理。";
        phoneClipboardStatus.classList.remove("error");
      } catch (error) {
        phoneClipboardStatus.textContent = error.message || "清理失败。";
        phoneClipboardStatus.classList.add("error");
      }
    });

    await refreshClipboards();
    clearTimer();
    refreshTimer = window.setInterval(() => {
      refreshClipboards().catch(() => {});
    }, 4000);
  }

  if (currentCode) {
    try {
      await fetchJson(buildRequestUrl(withBasePath("/api/clipboard-rooms/join"), { code: currentCode }), { method: "POST" });
      await renderWorkspace();
      return;
    } catch (error) {
      clearStoredClipboardCode();
      currentCode = "";
    }
  }

  renderPairView();
}

async function renderDownloadPage(shareId) {
  app.innerHTML = `
    <section class="download-layout">
      <article class="card">
        <h2>下载电脑发送的文件</h2>
        <p>如果电脑还在继续上传文件，这个列表会自动刷新。</p>
        <div id="downloadList" class="file-list"></div>
        <div class="actions">
          <a class="button-link secondary" href="${withBasePath("/")}">返回首页</a>
        </div>
      </article>
    </section>
  `;

  const downloadList = document.querySelector("#downloadList");

  async function refreshShare() {
    try {
      const payload = await fetchJson(withBasePath(`/api/shares/${shareId}`));
      downloadList.innerHTML = payload.share.files.length
        ? payload.share.files.map(fileItemTemplate).join("")
        : `<div class="empty">电脑端正在准备文件，请稍等片刻后自动刷新。</div>`;
    } catch (error) {
      downloadList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
  }

  await refreshShare();
  window.setInterval(() => {
    refreshShare().catch(() => {});
  }, 4000);
}

function bootstrap() {
  const pathName = stripBasePath(window.location.pathname);
  if (pathName === "/") {
    renderModeSelector();
    return;
  }

  if (pathName === "/desktop-transfer") {
    renderDesktopTransfer();
    return;
  }

  if (pathName === "/phone-transfer") {
    renderPhoneTransfer();
    return;
  }

  if (pathName === "/clipboard-transfer") {
    renderClipboardTransfer();
    return;
  }

  if (pathName === "/upload" || pathName === "/mobile/upload") {
    renderDeviceUpload();
    return;
  }

  if (pathName.startsWith("/download/")) {
    const shareId = pathName.split("/").pop();
    renderDownloadPage(shareId);
    return;
  }

  renderModeSelector();
}

bootstrap();
