import { createMeasurementId } from "./offline-store.js";
import { ReliableMeasurementSocket } from "./reliable-socket.js";
import { createCameraRecorder } from "./camera-recorder.js";
import {
  assertCameraSupport,
  describeCameraError,
  setCameraMessage,
  startEnvironmentCamera,
  waitForOpenCv,
} from "./camera-support.js";

const video = document.querySelector("#camera");
const canvas = document.querySelector("#processedFrame");
const cameraMessage = document.querySelector("#cameraMessage");
const tiltGuide = document.querySelector("#tiltGuide");
const startButton = document.querySelector("#startCamera");
const restartCalibrationButton = document.querySelector("#restartCalibration");
const calibrationStatus = document.querySelector("#calibrationStatus");
const thresholdInput = document.querySelector("#threshold");
const thresholdLabel = document.querySelector("#thresholdLabel");
const modeInput = document.querySelector("#detectionMode");
const modeHelp = document.querySelector("#modeHelp");
const sampleInterval = document.querySelector("#sampleInterval");
const visionStatus = document.querySelector("#visionStatus");
const liveVolume = document.querySelector("#liveVolume");
const networkStatus = document.querySelector("#networkStatus");
const introDialog = document.querySelector("#introDialog");
const introConfirm = document.querySelector("#introConfirm");
const calibrationDialog = document.querySelector("#calibrationDialog");
const calibrationForm = document.querySelector("#calibrationForm");
const calibrationStepLabel = document.querySelector("#calibrationStepLabel");
const calibrationTitle = document.querySelector("#calibrationTitle");
const calibrationPrompt = document.querySelector("#calibrationPrompt");
const actualVolumeInput = document.querySelector("#actualVolume");
const completionDialog = document.querySelector("#completionDialog");
const completionConfirm = document.querySelector("#completionConfirm");

const calibrationKey = "titration-burette-calibration";
const savedCalibration = JSON.parse(localStorage.getItem(calibrationKey) ?? "null");
const calibration = savedCalibration?.point1Y !== undefined
  ? savedCalibration
  : {
      point1Y: savedCalibration?.zeroY ?? null,
      point1Volume: 0,
      point2Y: savedCalibration?.referenceY ?? null,
      point2Volume: savedCalibration?.referenceVolume ?? null,
      scale: savedCalibration?.scale ?? null,
    };

let currentY = null;
let currentVolume = null;
let cameraCapture = null;
let sourceFrame = null;
let animationFrame = null;
let lastMeasurementAt = 0;
let lastProcessedAt = 0;
let calibrationStage = calibration.scale ? "complete" : "waiting-first";
let tutorialOpen = false;
let calibrationDialogOpen = false;
let referenceTemplate = null;
let referenceTemplateOrigin = null;
let latestRectifiedFrame = null;
let motionOffsetY = 0;
let motionConfidence = 1;
let motionFrameCount = 0;
let rejectedMeniscusFrames = 0;
const stableMeniscusPoints = [];
const filteredMeniscusPoints = [];
const orientation = { beta: 0, gamma: 0 };
const recorder = createCameraRecorder("burette");

const socket = new ReliableMeasurementSocket("burette", (connected) => {
  networkStatus.textContent = connected ? "서버 연결됨" : "오프라인 저장";
  networkStatus.classList.toggle("online", connected);
});
socket.connect();

function saveCalibration() {
  localStorage.setItem(calibrationKey, JSON.stringify(calibration));
}

function updateCalibration() {
  if (
    calibration.point1Y === null ||
    calibration.point2Y === null ||
    calibration.point1Volume === null ||
    calibration.point2Volume === null ||
    calibration.point2Y === calibration.point1Y
  ) {
    calibration.scale = null;
  } else {
    calibration.scale = (calibration.point2Volume - calibration.point1Volume) /
      (calibration.point2Y - calibration.point1Y);
  }
  saveCalibration();
}

function resetCalibration() {
  Object.assign(calibration, {
    point1Y: null,
    point1Volume: null,
    point2Y: null,
    point2Volume: null,
    scale: null,
  });
  calibrationStage = "waiting-first";
  stableMeniscusPoints.length = 0;
  filteredMeniscusPoints.length = 0;
  referenceTemplate?.delete();
  referenceTemplate = null;
  referenceTemplateOrigin = null;
  motionOffsetY = 0;
  motionConfidence = 1;
  currentVolume = null;
  liveVolume.textContent = "--.-- mL";
  calibrationStatus.textContent = "메니스커스를 찾는 중입니다. 뷰렛을 움직이지 마세요.";
  saveCalibration();
}

function createTrackingGray(frame) {
  const gray = new cv.Mat();
  const equalized = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  cv.equalizeHist(gray, equalized);
  cv.GaussianBlur(equalized, blurred, new cv.Size(3, 3), 0);
  cv.Canny(blurred, edges, 35, 110);
  gray.delete();
  equalized.delete();
  blurred.delete();
  return edges;
}

function captureMotionReference(frame) {
  referenceTemplate?.delete();
  const gray = createTrackingGray(frame);
  const rectangle = new cv.Rect(
    Math.round(frame.cols * 0.1),
    Math.round(frame.rows * 0.28),
    Math.round(frame.cols * 0.8),
    Math.round(frame.rows * 0.42),
  );
  referenceTemplate = gray.roi(rectangle).clone();
  referenceTemplateOrigin = { x: rectangle.x, y: rectangle.y };
  motionOffsetY = 0;
  motionConfidence = 1;
  gray.delete();
}

function estimateCameraMotion(frame) {
  if (!referenceTemplate || !referenceTemplateOrigin) {
    return { offsetY: 0, confidence: 1 };
  }
  motionFrameCount += 1;
  if (motionFrameCount % 3 !== 0) {
    return { offsetY: motionOffsetY, confidence: motionConfidence };
  }

  const gray = createTrackingGray(frame);
  const horizontalMargin = Math.round(frame.cols * 0.08);
  const verticalMargin = Math.round(frame.rows * 0.14);
  const expectedX = referenceTemplateOrigin.x;
  const expectedY = referenceTemplateOrigin.y + motionOffsetY;
  const searchX = Math.max(0, expectedX - horizontalMargin);
  const searchY = Math.max(0, Math.round(expectedY - verticalMargin));
  const searchWidth = Math.min(
    frame.cols - searchX,
    referenceTemplate.cols + horizontalMargin * 2,
  );
  const searchHeight = Math.min(
    frame.rows - searchY,
    referenceTemplate.rows + verticalMargin * 2,
  );
  if (searchWidth < referenceTemplate.cols || searchHeight < referenceTemplate.rows) {
    gray.delete();
    motionConfidence = 0;
    return { offsetY: motionOffsetY, confidence: 0 };
  }

  const search = gray.roi(new cv.Rect(searchX, searchY, searchWidth, searchHeight));
  const result = new cv.Mat();
  cv.matchTemplate(search, referenceTemplate, result, cv.TM_CCOEFF_NORMED);
  const match = cv.minMaxLoc(result);
  const measuredOffsetY = searchY + match.maxLoc.y - referenceTemplateOrigin.y;
  if (match.maxVal >= 0.48 && Math.abs(measuredOffsetY - motionOffsetY) <= verticalMargin) {
    motionOffsetY = motionOffsetY * 0.65 + measuredOffsetY * 0.35;
  }
  motionConfidence = match.maxVal;
  gray.delete();
  search.delete();
  result.delete();
  return { offsetY: motionOffsetY, confidence: motionConfidence };
}

function filterMeniscusPosition(rawY, detectionConfidence, movement) {
  if (rawY === null || detectionConfidence < 0.48 || movement.confidence < 0.48) {
    rejectedMeniscusFrames += 1;
    if (rejectedMeniscusFrames >= 8) filteredMeniscusPoints.length = 0;
    return null;
  }
  const correctedY = rawY - movement.offsetY;
  if (filteredMeniscusPoints.length) {
    const sorted = [...filteredMeniscusPoints].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (Math.abs(correctedY - median) > 24 && rejectedMeniscusFrames < 3) {
      rejectedMeniscusFrames += 1;
      return null;
    }
  }
  rejectedMeniscusFrames = 0;
  filteredMeniscusPoints.push(correctedY);
  if (filteredMeniscusPoints.length > 5) filteredMeniscusPoints.shift();
  const sorted = [...filteredMeniscusPoints].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function trackStableMeniscus(yPosition) {
  if (yPosition === null) {
    stableMeniscusPoints.length = 0;
    return false;
  }
  stableMeniscusPoints.push(yPosition);
  if (stableMeniscusPoints.length > 12) stableMeniscusPoints.shift();
  if (stableMeniscusPoints.length < 10) return false;
  return Math.max(...stableMeniscusPoints) - Math.min(...stableMeniscusPoints) < 3.5;
}

function showCalibrationDialog(step) {
  if (calibrationDialogOpen || tutorialOpen) return;
  calibrationDialogOpen = true;
  if (step === 1) {
    calibrationStepLabel.textContent = "보정 1단계";
    calibrationTitle.textContent = "메니스커스를 인식했습니다";
    calibrationPrompt.textContent = "보정 중입니다. 현재 뷰렛이 가리키는 실제 부피가 몇 mL인지 입력해주세요.";
    actualVolumeInput.value = "0.00";
  } else {
    calibrationStepLabel.textContent = "보정 2단계";
    calibrationTitle.textContent = "두 번째 위치를 인식했습니다";
    calibrationPrompt.textContent = "콕을 잠갔다면 현재 뷰렛이 가리키는 실제 부피를 입력해주세요.";
    actualVolumeInput.value = calibration.point1Volume !== null
      ? (Number(calibration.point1Volume) + 5).toFixed(2)
      : "5.00";
  }
  calibrationDialog.showModal();
  requestAnimationFrame(() => actualVolumeInput.select());
}

function updateCalibrationTutorial(isStable) {
  if (tutorialOpen || calibrationDialogOpen || !isStable) return;
  if (calibrationStage === "waiting-first") {
    showCalibrationDialog(1);
  } else if (
    calibrationStage === "waiting-second" &&
    calibration.point1Y !== null &&
    Math.abs(currentY - calibration.point1Y) >= 24
  ) {
    showCalibrationDialog(2);
  }
}

async function enableOrientation() {
  if (typeof DeviceOrientationEvent === "undefined") return;
  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") return;
    }
  } catch {
    // 동작 센서 권한이 없어도 카메라와 영상 기반 원근 보정은 계속 사용한다.
    return;
  }
  window.addEventListener("deviceorientation", (event) => {
    orientation.beta = Number(event.beta ?? 0);
    orientation.gamma = Number(event.gamma ?? 0);
    tiltGuide.classList.toggle("hidden", Math.abs(orientation.gamma) < 7);
  });
}

function findBuretteEdges(edgeImage) {
  const lines = new cv.Mat();
  cv.HoughLinesP(
    edgeImage,
    lines,
    1,
    Math.PI / 180,
    45,
    edgeImage.rows * 0.3,
    edgeImage.rows * 0.08,
  );

  const candidates = [];
  for (let index = 0; index < lines.rows; index += 1) {
    const offset = index * 4;
    const x1 = lines.data32S[offset];
    const y1 = lines.data32S[offset + 1];
    const x2 = lines.data32S[offset + 2];
    const y2 = lines.data32S[offset + 3];
    const deltaX = x2 - x1;
    const deltaY = y2 - y1;
    if (Math.abs(deltaY) < edgeImage.rows * 0.28 || Math.abs(deltaX) > Math.abs(deltaY) * 0.45) {
      continue;
    }
    const slope = deltaX / deltaY;
    candidates.push({
      middleX: (x1 + x2) / 2,
      topX: x1 - slope * y1,
      bottomX: x1 + slope * (edgeImage.rows - y1),
    });
  }
  lines.delete();
  if (candidates.length < 2) return null;

  candidates.sort((left, right) => left.middleX - right.middleX);
  const left = candidates[0];
  const right = candidates[candidates.length - 1];
  if (right.middleX - left.middleX < edgeImage.cols * 0.18) return null;
  return { left, right };
}

function rectifyFrame(source) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, 45, 130);
  const detectedEdges = findBuretteEdges(edges);

  const width = source.cols;
  const height = source.rows;
  const imuShift = Math.max(-0.08, Math.min(0.08, orientation.gamma / 450)) * width;
  const topInset = Math.max(-0.04, Math.min(0.04, (orientation.beta - 90) / 900)) * width;
  const sourcePoints = detectedEdges
    ? [
        detectedEdges.left.topX + imuShift + topInset,
        0,
        detectedEdges.right.topX + imuShift - topInset,
        0,
        detectedEdges.right.bottomX - imuShift,
        height,
        detectedEdges.left.bottomX - imuShift,
        height,
      ]
    : [imuShift + topInset, 0, width + imuShift - topInset, 0, width - imuShift, height, -imuShift, height];
  const destinationPoints = [0, 0, width, 0, width, height, 0, height];
  const sourceMatrix = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints);
  const destinationMatrix = cv.matFromArray(4, 1, cv.CV_32FC2, destinationPoints);
  const transform = cv.getPerspectiveTransform(sourceMatrix, destinationMatrix);
  const result = new cv.Mat();
  cv.warpPerspective(
    source,
    result,
    transform,
    new cv.Size(width, height),
    cv.INTER_LINEAR,
    cv.BORDER_REPLICATE,
  );

  gray.delete();
  blurred.delete();
  edges.delete();
  sourceMatrix.delete();
  destinationMatrix.delete();
  transform.delete();
  return result;
}

function detectMeniscus(frame) {
  const gray = new cv.Mat();
  const filtered = new cv.Mat();
  const equalized = new cv.Mat();
  const binary = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, filtered, new cv.Size(5, 5), 0);
  cv.equalizeHist(filtered, equalized);
  const threshold = Number(thresholdInput.value);
  if (modeInput.value === "canny") {
    const sensitivity = threshold / 90;
    cv.Canny(equalized, binary, 38 * sensitivity, 115 * sensitivity);
  } else {
    cv.threshold(equalized, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
  }

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
  let bestContour = null;
  let bestBounds = null;
  let bestScore = -Infinity;
  const horizontalCenter = frame.cols / 2;

  for (let index = 0; index < contours.size(); index += 1) {
    const contour = contours.get(index);
    const bounds = cv.boundingRect(contour);
    const centerPenalty = Math.abs(bounds.x + bounds.width / 2 - horizontalCenter);
    const isMeniscusShape =
      bounds.width > frame.cols * 0.16 &&
      bounds.height < frame.rows * 0.18 &&
      bounds.y > frame.rows * 0.03 &&
      bounds.y < frame.rows * 0.97;
    const score = bounds.width - centerPenalty * 0.35 - bounds.height * 0.2;
    if (isMeniscusShape && score > bestScore) {
      bestContour?.delete();
      bestContour = contour.clone();
      bestBounds = bounds;
      bestScore = score;
    }
    contour.delete();
  }

  let minimumY = null;
  let confidence = 0;
  if (bestContour) {
    minimumY = Infinity;
    for (let index = 0; index < bestContour.data32S.length; index += 2) {
      minimumY = Math.min(minimumY, bestContour.data32S[index + 1]);
    }
    cv.line(
      frame,
      new cv.Point(0, minimumY),
      new cv.Point(frame.cols, minimumY),
      new cv.Scalar(241, 200, 74, 255),
      3,
    );
    const widthScore = Math.min(1, bestBounds.width / (frame.cols * 0.45));
    const centerDistance = Math.abs(bestBounds.x + bestBounds.width / 2 - horizontalCenter);
    const centerScore = Math.max(0, 1 - centerDistance / (frame.cols * 0.5));
    confidence = widthScore * 0.65 + centerScore * 0.35;
    bestContour.delete();
  }

  gray.delete();
  filtered.delete();
  equalized.delete();
  binary.delete();
  contours.delete();
  hierarchy.delete();
  return { y: minimumY, confidence };
}

async function recordVolume(timestamp) {
  if (currentVolume === null) return;
  const measurement = {
    id: createMeasurementId("burette"),
    timestamp,
    volume: Number(currentVolume.toFixed(4)),
  };
  await socket.storeAndSend(measurement);
}

function ensureFrameDimensions() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return false;
  video.width = width;
  video.height = height;
  if (sourceFrame && sourceFrame.cols === width && sourceFrame.rows === height) return true;
  sourceFrame?.delete();
  sourceFrame = new cv.Mat(height, width, cv.CV_8UC4);
  canvas.width = width;
  canvas.height = height;
  resetCalibration();
  return true;
}

function processFrame(timestamp) {
  if (!cameraCapture || !sourceFrame) return;
  if (timestamp - lastProcessedAt < 100) {
    animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  lastProcessedAt = timestamp;
  if (!ensureFrameDimensions()) {
    animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  try {
    cameraCapture.read(sourceFrame);
  } catch {
    sourceFrame?.delete();
    sourceFrame = null;
    calibrationStatus.textContent = "카메라 영상을 다시 연결하는 중입니다.";
    ensureFrameDimensions();
    animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  const rectified = rectifyFrame(sourceFrame);
  latestRectifiedFrame?.delete();
  latestRectifiedFrame = rectified.clone();
  const detection = detectMeniscus(rectified);
  const movement = estimateCameraMotion(rectified);
  currentY = filterMeniscusPosition(detection.y, detection.confidence, movement);
  const isStable = trackStableMeniscus(currentY);

  if (currentY !== null) {
    if (calibration.scale !== null) {
      currentVolume = calibration.point1Volume + (currentY - calibration.point1Y) * calibration.scale;
      liveVolume.textContent = `${currentVolume.toFixed(2)} mL`;
      calibrationStatus.textContent = "보정 완료 · 부피를 기록하고 있습니다.";
      if (timestamp - lastMeasurementAt >= Number(sampleInterval.value)) {
        lastMeasurementAt = timestamp;
        recordVolume(Date.now());
      }
    } else if (calibrationStage === "waiting-second") {
      calibrationStatus.textContent = "콕을 열어 액체를 3~5 mL 정도 배출한 뒤 다시 잠가주세요.";
    } else {
      calibrationStatus.textContent = isStable
        ? "메니스커스를 인식했습니다."
        : "메니스커스를 찾는 중입니다. 뷰렛을 움직이지 마세요.";
    }
    updateCalibrationTutorial(isStable);
  } else if (!tutorialOpen) {
    calibrationStatus.textContent = movement.confidence < 0.48 && referenceTemplate
      ? "카메라 위치가 크게 바뀌었습니다. 눈금이 다시 보이도록 천천히 맞추면 측정을 재개합니다."
      : "측정 품질을 확인하는 중입니다. 눈금과 메니스커스가 선명하게 보이도록 잠시 고정해주세요.";
  }

  cv.imshow(canvas, rectified);
  canvas.classList.add("active");
  setCameraMessage(cameraMessage, "");
  rectified.delete();
  animationFrame = requestAnimationFrame(processFrame);
}

async function startCamera() {
  startButton.disabled = true;
  setCameraMessage(cameraMessage, "카메라 권한과 영상을 확인하는 중입니다.");
  try {
    assertCameraSupport();
    await Promise.all([waitForOpenCv(visionStatus), enableOrientation()]);
    const stream = await startEnvironmentCamera(video);
    recorder.attachStream(stream);
    ensureFrameDimensions();
    cameraCapture = new cv.VideoCapture(video);
    resetCalibration();
    startButton.querySelector("span").textContent = "카메라 실행 중";
    restartCalibrationButton.disabled = false;
    tutorialOpen = true;
    introDialog.showModal();
    animationFrame = requestAnimationFrame(processFrame);
  } catch (error) {
    startButton.disabled = false;
    startButton.querySelector("span").textContent = "카메라 다시 시작";
    visionStatus.textContent = error.name === "NotAllowedError" ? "권한 필요" : "오류";
    setCameraMessage(cameraMessage, describeCameraError(error), "error");
  }
}

startButton.addEventListener("click", startCamera);
thresholdInput.addEventListener("input", () => {
  thresholdLabel.textContent = thresholdInput.value;
});
modeInput.addEventListener("change", () => {
  modeHelp.innerHTML = modeInput.value === "canny"
    ? "<strong>Canny</strong>는 투명한 액체의 가는 경계가 보일 때 적합합니다. 일반적인 조명에서는 이 설정을 먼저 사용하세요."
    : "<strong>밝기 이진화</strong>는 액체와 배경의 밝기 차이가 크지만 반사광 때문에 Canny 선이 끊길 때 사용하세요.";
});
introConfirm.addEventListener("click", () => {
  tutorialOpen = false;
  introDialog.close();
  calibrationStatus.textContent = calibration.scale
    ? "저장된 보정을 확인하는 중입니다."
    : "메니스커스를 찾는 중입니다. 뷰렛을 움직이지 마세요.";
});
calibrationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const actualVolume = Number(actualVolumeInput.value);
  if (!Number.isFinite(actualVolume) || currentY === null) return;
  if (calibrationStage === "waiting-first") {
    calibration.point1Y = currentY;
    calibration.point1Volume = actualVolume;
    if (latestRectifiedFrame) captureMotionReference(latestRectifiedFrame);
    calibrationStage = "waiting-second";
    calibrationStatus.textContent = "콕을 열어 액체를 3~5 mL 정도 배출한 뒤 다시 잠가주세요.";
  } else if (calibrationStage === "waiting-second") {
    calibration.point2Y = currentY;
    calibration.point2Volume = actualVolume;
    updateCalibration();
    if (calibration.scale === null || Math.abs(actualVolume - calibration.point1Volume) < 0.1) {
      calibration.point2Y = null;
      calibration.point2Volume = null;
      calibrationStatus.textContent = "두 지점의 부피가 달라야 합니다. 조금 더 배출한 뒤 다시 입력해주세요.";
    } else {
      calibrationStage = "complete";
      completionDialog.showModal();
    }
  }
  stableMeniscusPoints.length = 0;
  calibrationDialogOpen = false;
  calibrationDialog.close();
  saveCalibration();
});
restartCalibrationButton.addEventListener("click", () => {
  resetCalibration();
  tutorialOpen = true;
  introDialog.showModal();
});
completionConfirm.addEventListener("click", () => {
  completionDialog.close();
  calibrationStatus.textContent = "보정 완료 · 부피를 기록하고 있습니다.";
});
[introDialog, calibrationDialog, completionDialog].forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => event.preventDefault());
});
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationFrame);
  sourceFrame?.delete();
  latestRectifiedFrame?.delete();
  referenceTemplate?.delete();
  video.srcObject?.getTracks().forEach((track) => track.stop());
  socket.stop();
  recorder.dispose();
});

saveCalibration();
waitForOpenCv(visionStatus).catch(() => {
  visionStatus.textContent = "로드 실패";
});
if (!globalThis.isSecureContext) {
  setCameraMessage(cameraMessage, describeCameraError({ name: "InsecureContextError" }), "error");
  startButton.disabled = true;
}
globalThis.addEventListener("load", () => globalThis.lucide?.createIcons());