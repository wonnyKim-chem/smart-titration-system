export function assertCameraSupport() {
  if (!globalThis.isSecureContext) {
    const error = new Error("HTTPS 연결이 필요합니다.");
    error.name = "InsecureContextError";
    throw error;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error("이 브라우저에서 카메라 API를 사용할 수 없습니다.");
    error.name = "UnsupportedError";
    throw error;
  }
}

export function describeCameraError(error) {
  const messages = {
    InsecureContextError: "카메라는 HTTPS 주소에서만 사용할 수 있습니다. 주소가 https://로 시작하는지 확인하세요.",
    UnsupportedError: "이 브라우저에서는 카메라 API를 사용할 수 없습니다. iOS와 브라우저를 업데이트하세요.",
    NotAllowedError: "카메라 권한이 차단되었습니다. iPhone 설정에서 이 브라우저의 카메라 권한을 허용하세요.",
    NotFoundError: "사용 가능한 카메라를 찾지 못했습니다.",
    NotReadableError: "다른 앱이 카메라를 사용 중입니다. 다른 앱을 닫고 다시 시도하세요.",
    OverconstrainedError: "요청한 카메라 조건을 지원하지 않습니다.",
    AbortError: "카메라를 시작하지 못했습니다. 브라우저를 다시 열어 주세요.",
    OpenCvTimeoutError: "OpenCV.js를 불러오지 못했습니다. 인터넷 연결이나 콘텐츠 차단기를 확인하세요.",
    VideoTimeoutError: "카메라는 열렸지만 영상을 받지 못했습니다. 탭을 새로고침해 주세요.",
  };
  return messages[error?.name] ?? `카메라 오류: ${error?.message || "알 수 없는 오류"}`;
}

export function setCameraMessage(element, message, state = "info") {
  element.textContent = message;
  element.dataset.state = state;
  element.classList.toggle("hidden", !message);
}

export function waitForOpenCv(statusElement, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (globalThis.cv?.Mat) {
        statusElement.textContent = "준비";
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const error = new Error("OpenCV.js 로딩 시간 초과");
        error.name = "OpenCvTimeoutError";
        reject(error);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function waitForVideoMetadata(video, timeoutMs = 10_000) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      const error = new Error("카메라 영상 준비 시간 초과");
      error.name = "VideoTimeoutError";
      reject(error);
    }, timeoutMs);
    const onMetadata = () => {
      if (video.videoWidth <= 0) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("canplay", onMetadata);
    };
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("canplay", onMetadata);
  });
}

export async function startEnvironmentCamera(video) {
  assertCameraSupport();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 960 },
      height: { ideal: 540 },
      frameRate: { ideal: 15, max: 24 },
    },
    audio: false,
  });
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute("playsinline", "");
  video.srcObject = stream;
  await waitForVideoMetadata(video);
  await video.play();
  return stream;
}