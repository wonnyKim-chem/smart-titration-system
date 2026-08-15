function selectRecordingType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createFilename(channel, mimeType) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace("T", "-").slice(0, 19);
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  return `${channel}-${timestamp}.${extension}`;
}

export class CameraRecorder {
  constructor(channel, elements) {
    this.channel = channel;
    this.elements = elements;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.recordingBlob = null;
    this.filename = null;
    this.startedAt = null;
    this.timer = null;
    this.mimeType = "";
    this.bindEvents();
  }

  bindEvents() {
    this.elements.start.addEventListener("click", () => this.start());
    this.elements.stop.addEventListener("click", () => this.stop());
    this.elements.download.addEventListener("click", () => this.download());
    this.elements.upload.addEventListener("click", () => this.upload());
  }

  attachStream(stream) {
    this.stream = stream;
    if (typeof MediaRecorder === "undefined") {
      this.elements.status.textContent = "이 브라우저는 영상 녹화를 지원하지 않습니다.";
      return;
    }
    const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    const resolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : "카메라 원본";
    this.elements.status.textContent = `${resolution} 영상 녹화 준비됨`;
    this.elements.start.disabled = false;
  }

  start() {
    if (!this.stream || this.recorder?.state === "recording") return;
    this.mimeType = selectRecordingType();
    const options = this.mimeType ? { mimeType: this.mimeType, videoBitsPerSecond: 2_500_000 } : undefined;
    try {
      this.chunks = [];
      this.recordingBlob = null;
      this.filename = null;
      this.recorder = new MediaRecorder(this.stream, options);
      this.recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      });
      this.recorder.addEventListener("stop", () => this.finish());
      this.recorder.addEventListener("error", () => {
        this.elements.status.textContent = "녹화 중 오류가 발생했습니다. 다시 시작해주세요.";
      });
      this.recorder.start(1_000);
      this.startedAt = Date.now();
      this.elements.start.disabled = true;
      this.elements.stop.disabled = false;
      this.elements.download.disabled = true;
      this.elements.upload.disabled = true;
      this.updateTimer();
      this.timer = setInterval(() => this.updateTimer(), 1_000);
    } catch (error) {
      this.elements.status.textContent = `녹화를 시작하지 못했습니다: ${error.message}`;
    }
  }

  updateTimer() {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1_000));
    const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
    const seconds = String(elapsedSeconds % 60).padStart(2, "0");
    this.elements.status.textContent = `녹화 중 ${minutes}:${seconds}`;
    this.elements.container.classList.add("recording-active");
  }

  stop() {
    if (this.recorder?.state !== "recording") return;
    this.recorder.stop();
    clearInterval(this.timer);
    this.elements.stop.disabled = true;
    this.elements.status.textContent = "녹화 파일을 준비하는 중입니다.";
  }

  finish() {
    const mimeType = this.recorder?.mimeType || this.mimeType || "video/webm";
    this.recordingBlob = new Blob(this.chunks, { type: mimeType });
    this.filename = createFilename(this.channel, mimeType);
    this.chunks = [];
    this.elements.container.classList.remove("recording-active");
    this.elements.status.textContent = `녹화 완료 · ${formatBytes(this.recordingBlob.size)}`;
    this.elements.start.disabled = false;
    this.elements.download.disabled = false;
    this.elements.upload.disabled = false;
  }

  download() {
    if (!this.recordingBlob) return;
    const url = URL.createObjectURL(this.recordingBlob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = this.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async upload() {
    if (!this.recordingBlob) return;
    this.elements.upload.disabled = true;
    this.elements.status.textContent = `서버로 전송 중 · ${formatBytes(this.recordingBlob.size)}`;
    try {
      const response = await fetch("/api/recordings", {
        method: "POST",
        headers: {
          "content-type": this.recordingBlob.type || "video/webm",
          "x-recording-channel": this.channel,
          "x-recording-filename": this.filename,
        },
        body: this.recordingBlob,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "서버 전송 실패");
      this.elements.status.textContent = `서버 저장 완료 · ${result.filename}`;
    } catch (error) {
      this.elements.status.textContent = `전송 실패 · 기기에 다운로드해 보관하세요. (${error.message})`;
      this.elements.upload.disabled = false;
    }
  }

  dispose() {
    clearInterval(this.timer);
    if (this.recorder?.state === "recording") this.recorder.stop();
  }
}

export function createCameraRecorder(channel) {
  return new CameraRecorder(channel, {
    container: document.querySelector("#recordingPanel"),
    start: document.querySelector("#startRecording"),
    stop: document.querySelector("#stopRecording"),
    download: document.querySelector("#downloadRecording"),
    upload: document.querySelector("#uploadRecording"),
    status: document.querySelector("#recordingStatus"),
  });
}