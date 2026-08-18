import { createMeasurementId } from "./offline-store.js";
import { ReliableMeasurementSocket } from "./reliable-socket.js";
import { createCameraRecorder } from "./camera-recorder.js";
import {
  evaluateOpticalAlignment,
  formatBuretteReading,
  relativeMeniscusTicks,
  roundBuretteReading,
} from "./burette-scale.js";
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
const tiltGuideText = document.querySelector("#tiltGuideText");
const startButton = document.querySelector("#startCamera");
const restartCalibrationButton = document.querySelector("#restartCalibration");
const calibrationStatus = document.querySelector("#calibrationStatus");
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

const calibrationKey = "titration-burette-calibration-v2";
const savedCalibration = JSON.parse(localStorage.getItem(calibrationKey) ?? "null");
const calibration = savedCalibration?.coordinateSystem === "minor-divisions"
  ? savedCalibration
  : {
      coordinateSystem: "minor-divisions",
      point1Y: null,
      point1Volume: null,
      point2Y: null,
      point2Volume: null,
      scale: null,
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
let tubeHintX = null;
let manualMeniscusHintY = null;
let trackedTubeGeometry = null;
let trackedTickPitch = null;
let previousScaleObservation = null;
let rollingScaleTemplate = null;
let rollingTemplateOrigin = null;
const stableMeniscusPoints = [];
const orientation = { beta: null, gamma: null, available: false };
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
    coordinateSystem: "minor-divisions",
    point1Y: null,
    point1Volume: null,
    point2Y: null,
    point2Volume: null,
    scale: null,
  });
  calibrationStage = "waiting-first";
  stableMeniscusPoints.length = 0;
  tubeHintX = null;
  manualMeniscusHintY = null;
  trackedTubeGeometry = null;
  trackedTickPitch = null;
  previousScaleObservation = null;
  rollingScaleTemplate?.delete();
  rollingScaleTemplate = null;
  rollingTemplateOrigin = null;
  currentVolume = null;
  liveVolume.textContent = "--.-- mL";
  calibrationStatus.textContent = "화면에서 메니스커스 가운데를 한 번 터치해주세요.";
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

function trackStableMeniscus(yPosition) {
  if (yPosition === null) {
    stableMeniscusPoints.length = 0;
    return false;
  }
  stableMeniscusPoints.push(yPosition);
  if (stableMeniscusPoints.length > 12) stableMeniscusPoints.shift();
  if (stableMeniscusPoints.length < 10) return false;
  return Math.max(...stableMeniscusPoints) - Math.min(...stableMeniscusPoints) < 0.35;
}

function showCalibrationDialog(step) {
  if (calibrationDialogOpen || tutorialOpen) return;
  calibrationDialogOpen = true;
  if (step === 1) {
    calibrationStepLabel.textContent = "보정 1단계";
    calibrationTitle.textContent = "메니스커스를 인식했습니다";
    calibrationPrompt.textContent = "보정 중입니다. 현재 뷰렛이 가리키는 실제 부피가 몇 mL인지 입력해주세요.";
    actualVolumeInput.value = "0.00";
  } else if (step === 2) {
    calibrationStepLabel.textContent = "보정 2단계";
    calibrationTitle.textContent = "두 번째 위치를 인식했습니다";
    calibrationPrompt.textContent = "콕을 잠갔다면 현재 뷰렛이 가리키는 실제 부피를 입력해주세요.";
    actualVolumeInput.value = calibration.point1Volume !== null
      ? (Number(calibration.point1Volume) + 5).toFixed(2)
      : "5.00";
  } else {
    calibrationStepLabel.textContent = "추적 기준 복원";
    calibrationTitle.textContent = "현재 눈금값을 다시 확인해주세요";
    calibrationPrompt.textContent =
      "카메라가 크게 이동한 동안의 변화를 임의로 계산하지 않습니다. 현재 메니스커스 눈금을 0.01 mL까지 입력해주세요.";
    actualVolumeInput.value = currentVolume !== null
      ? roundBuretteReading(currentVolume).toFixed(2)
      : "0.00";
  }
  calibrationDialog.showModal();
  requestAnimationFrame(() => actualVolumeInput.select());
}

function updateCalibrationTutorial(isStable) {
  if (tutorialOpen || calibrationDialogOpen || !isStable) return;
  if (calibrationStage === "waiting-first") {
    showCalibrationDialog(1);
  } else if (calibrationStage === "reanchor") {
    showCalibrationDialog(3);
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
    orientation.beta = Number(event.beta);
    orientation.gamma = Number(event.gamma);
    orientation.available = Number.isFinite(orientation.beta) && Number.isFinite(orientation.gamma);
    const pitchError = orientation.available ? Math.abs(Math.abs(orientation.beta) - 90) : 0;
    const rollError = orientation.available ? Math.abs(orientation.gamma) : 0;
    if (orientation.available && pitchError > 5) {
      tiltGuideText.textContent = "휴대폰을 위아래로 기울이지 말고 렌즈를 수평으로 맞춰주세요";
    } else {
      tiltGuideText.textContent = "뷰렛이 세로선과 평행하도록 휴대폰을 회전해주세요";
    }
    tiltGuide.classList.toggle("hidden", !orientation.available || (pitchError <= 5 && rollError <= 3));
  });
}

function locateTube(frame) {
  const gray = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  const hintX = Math.round(tubeHintX ?? frame.cols / 2);
  const searchHalfWidth = Math.max(48, Math.round(frame.cols * 0.13));
  const searchLeft = Math.max(2, hintX - searchHalfWidth);
  const searchRight = Math.min(frame.cols - 3, hintX + searchHalfWidth);
  const top = Math.round(frame.rows * 0.08);
  const bottom = Math.round(frame.rows * 0.92);
  const columnScores = new Float32Array(frame.cols);
  const pixels = gray.data;

  for (let x = searchLeft; x <= searchRight; x += 1) {
    let score = 0;
    let samples = 0;
    for (let y = top; y < bottom; y += 3) {
      const offset = y * frame.cols + x;
      score += Math.abs(pixels[offset + 1] - pixels[offset - 1]);
      samples += 1;
    }
    columnScores[x] = score / Math.max(1, samples);
  }

  const candidates = [];
  for (let x = searchLeft + 1; x < searchRight; x += 1) {
    if (columnScores[x] >= columnScores[x - 1] && columnScores[x] > columnScores[x + 1]) {
      candidates.push({ x, score: columnScores[x] });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const strongest = candidates.slice(0, 24);
  const expectedWidth = trackedTubeGeometry?.width ?? frame.cols * 0.05;
  const minimumWidth = Math.max(10, frame.cols * 0.012);
  const maximumWidth = Math.min(searchHalfWidth * 1.25, frame.cols * 0.12);
  let bestPair = null;
  let bestScore = -Infinity;

  for (const left of strongest) {
    for (const right of strongest) {
      if (right.x <= left.x) continue;
      const width = right.x - left.x;
      const centerX = (left.x + right.x) / 2;
      if (width < minimumWidth || width > maximumWidth) continue;
      if (left.x >= hintX || right.x <= hintX) continue;
      if (Math.abs(centerX - hintX) > searchHalfWidth * 0.48) continue;
      const strength = left.score + right.score;
      const centerPenalty = Math.abs(centerX - hintX) / searchHalfWidth;
      const widthPenalty = Math.abs(Math.log(width / expectedWidth));
      const pairScore = strength - centerPenalty * 10 - widthPenalty * 4;
      if (pairScore > bestScore) {
        bestScore = pairScore;
        bestPair = { leftX: left.x, rightX: right.x, centerX, width };
      }
    }
  }
  gray.delete();

  if (!bestPair) {
    return trackedTubeGeometry
      ? { ...trackedTubeGeometry, confidence: 0.25 }
      : null;
  }
  const geometry = trackedTubeGeometry
    ? {
        leftX: trackedTubeGeometry.leftX * 0.65 + bestPair.leftX * 0.35,
        rightX: trackedTubeGeometry.rightX * 0.65 + bestPair.rightX * 0.35,
        centerX: trackedTubeGeometry.centerX * 0.65 + bestPair.centerX * 0.35,
        width: trackedTubeGeometry.width * 0.65 + bestPair.width * 0.35,
        confidence: 0.75,
      }
    : { ...bestPair, confidence: 0.7 };
  trackedTubeGeometry = geometry;
  tubeHintX = geometry.centerX;
  return geometry;
}

function estimateTubePerspective(frame, geometry) {
  const halfWidth = Math.max(24, Math.round(geometry.width * 2.2));
  const roiX = Math.max(0, Math.round(geometry.centerX - halfWidth));
  const roiWidth = Math.min(frame.cols - roiX, halfWidth * 2);
  if (roiWidth < 16) return null;
  const roi = frame.roi(new cv.Rect(roiX, 0, roiWidth, frame.rows));
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const lines = new cv.Mat();
  cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  cv.Canny(blurred, edges, 35, 110);
  cv.HoughLinesP(
    edges,
    lines,
    1,
    Math.PI / 180,
    30,
    frame.rows * 0.16,
    frame.rows * 0.08,
  );

  const upperY = frame.rows * 0.25;
  const lowerY = frame.rows * 0.75;
  let bestLeft = null;
  let bestRight = null;
  for (let index = 0; index < lines.rows; index += 1) {
    const offset = index * 4;
    const x1 = lines.data32S[offset];
    const y1 = lines.data32S[offset + 1];
    const x2 = lines.data32S[offset + 2];
    const y2 = lines.data32S[offset + 3];
    const deltaX = x2 - x1;
    const deltaY = y2 - y1;
    if (Math.abs(deltaY) < frame.rows * 0.14 || Math.abs(deltaX) > Math.abs(deltaY) * 0.2) {
      continue;
    }
    const slope = deltaX / deltaY;
    const xAt = (targetY) => roiX + x1 + slope * (targetY - y1);
    const middleX = xAt(frame.rows / 2);
    const expectedX = middleX < geometry.centerX ? geometry.leftX : geometry.rightX;
    const length = Math.hypot(deltaX, deltaY);
    const score = length - Math.abs(middleX - expectedX) * 8;
    const candidate = {
      upperX: xAt(upperY),
      lowerX: xAt(lowerY),
      score,
    };
    if (middleX < geometry.centerX) {
      if (!bestLeft || score > bestLeft.score) bestLeft = candidate;
    } else if (!bestRight || score > bestRight.score) {
      bestRight = candidate;
    }
  }
  roi.delete();
  gray.delete();
  blurred.delete();
  edges.delete();
  lines.delete();
  if (!bestLeft || !bestRight) return null;

  const upperWidth = bestRight.upperX - bestLeft.upperX;
  const lowerWidth = bestRight.lowerX - bestLeft.lowerX;
  if (upperWidth < 6 || lowerWidth < 6) return null;
  const upperCenterX = (bestLeft.upperX + bestRight.upperX) / 2;
  const lowerCenterX = (bestLeft.lowerX + bestRight.lowerX) / 2;
  return {
    upperTubeWidth: upperWidth,
    lowerTubeWidth: lowerWidth,
    axisTiltDegrees: Math.atan2(lowerCenterX - upperCenterX, lowerY - upperY) * 180 / Math.PI,
  };
}

function estimatePeriodicPitch(signal) {
  if (signal.length < 32) return null;
  const mean = signal.reduce((sum, value) => sum + value, 0) / signal.length;
  const centered = Array.from(signal, (value) => value - mean);
  const maximumPitch = Math.min(24, Math.floor(signal.length / 8));
  const correlations = new Map();
  for (let lag = 3; lag <= maximumPitch * 3; lag += 1) {
    let numerator = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index + lag < centered.length; index += 1) {
      const leftValue = centered[index];
      const rightValue = centered[index + lag];
      numerator += leftValue * rightValue;
      leftEnergy += leftValue * leftValue;
      rightEnergy += rightValue * rightValue;
    }
    correlations.set(lag, numerator / Math.sqrt(Math.max(1, leftEnergy * rightEnergy)));
  }

  let bestPitch = null;
  let bestScore = -Infinity;
  for (let pitch = 3; pitch <= maximumPitch; pitch += 1) {
    const fundamental = correlations.get(pitch) ?? -1;
    const second = correlations.get(pitch * 2) ?? 0;
    const third = correlations.get(pitch * 3) ?? 0;
    const score = fundamental + second * 0.3 + third * 0.15;
    if (fundamental > 0.08 && score > bestScore) {
      bestPitch = pitch;
      bestScore = score;
    }
  }
  if (bestPitch === null) return null;
  return {
    pitch: bestPitch,
    confidence: Math.max(0, Math.min(1, bestScore / 0.65)),
  };
}

function estimateTickPitch(frame, geometry, centerY) {
  const gray = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  const halfBand = Math.max(14, Math.round(geometry.width * 1.65));
  const left = Math.max(1, Math.round(geometry.centerX - halfBand));
  const right = Math.min(frame.cols - 2, Math.round(geometry.centerX + halfBand));
  const halfHeight = Math.min(Math.round(frame.rows * 0.38), 360);
  const top = Math.max(2, Math.round(centerY - halfHeight));
  const bottom = Math.min(frame.rows - 3, Math.round(centerY + halfHeight));
  const signal = new Float64Array(bottom - top + 1);
  const grayPixels = gray.data;
  const colorPixels = frame.data;

  for (let y = top; y <= bottom; y += 1) {
    let edgeTotal = 0;
    let redTotal = 0;
    let samples = 0;
    for (let x = left; x <= right; x += 2) {
      const grayOffset = y * frame.cols + x;
      edgeTotal += Math.abs(
        grayPixels[grayOffset + frame.cols] - grayPixels[grayOffset - frame.cols],
      );
      const colorOffset = grayOffset * 4;
      const red = colorPixels[colorOffset];
      const green = colorPixels[colorOffset + 1];
      const blue = colorPixels[colorOffset + 2];
      redTotal += Math.max(0, red - green * 0.55 - blue * 0.45 - 10);
      samples += 1;
    }
    signal[y - top] = (edgeTotal + redTotal * 0.7) / Math.max(1, samples);
  }
  gray.delete();

  const overall = estimatePeriodicPitch(signal);
  if (!overall) return null;
  const centerIndex = Math.max(0, Math.min(signal.length - 1, Math.round(centerY - top)));
  const upper = estimatePeriodicPitch(signal.slice(0, Math.max(0, centerIndex - 2)));
  const lower = estimatePeriodicPitch(signal.slice(Math.min(signal.length, centerIndex + 3)));
  const bestPitch = overall.pitch;
  const currentConfidence = overall.confidence;
  if (
    trackedTickPitch !== null &&
    bestPitch / trackedTickPitch > 0.68 &&
    bestPitch / trackedTickPitch < 1.45
  ) {
    trackedTickPitch = trackedTickPitch * 0.72 + bestPitch * 0.28;
  } else if (trackedTickPitch === null || currentConfidence >= 0.55) {
    trackedTickPitch = bestPitch;
  }
  return {
    pitch: trackedTickPitch,
    confidence: currentConfidence,
    upperPitch: upper?.confidence >= 0.16 ? upper.pitch : null,
    lowerPitch: lower?.confidence >= 0.16 ? lower.pitch : null,
    signal,
    signalTop: top,
  };
}

function detectMeniscusInTube(frame, geometry, tick, predictedY, tubeRollDegrees = 0) {
  const gray = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  const halfInterior = Math.max(3, Math.round(geometry.width * 0.32));
  const left = Math.max(1, Math.round(geometry.centerX - halfInterior));
  const right = Math.min(frame.cols - 2, Math.round(geometry.centerX + halfInterior));
  const searchRadius = manualMeniscusHintY !== null
    ? Math.max(12, tick.pitch * 2.2)
    : Math.max(28, tick.pitch * 5.5);
  const centerY = manualMeniscusHintY ?? predictedY ?? frame.rows / 2;
  const top = Math.max(2, Math.round(centerY - searchRadius));
  const bottom = Math.min(frame.rows - 3, Math.round(centerY + searchRadius));
  const rowMeans = new Float64Array(bottom - top + 1);
  const pixels = gray.data;
  const rollTangent = Math.tan(tubeRollDegrees * Math.PI / 180);

  for (let y = top; y <= bottom; y += 1) {
    let total = 0;
    for (let x = left; x <= right; x += 1) {
      const sampleY = Math.max(
        0,
        Math.min(frame.rows - 1, Math.round(y - rollTangent * (x - geometry.centerX))),
      );
      total += pixels[sampleY * frame.cols + x];
    }
    rowMeans[y - top] = total / Math.max(1, right - left + 1);
  }
  const scores = new Float64Array(rowMeans.length);
  const backgroundRadius = Math.max(3, Math.round(tick.pitch * 1.8));
  for (let index = 1; index < rowMeans.length - 1; index += 1) {
    let background = 0;
    let samples = 0;
    for (
      let offset = Math.max(0, index - backgroundRadius);
      offset <= Math.min(rowMeans.length - 1, index + backgroundRadius);
      offset += 1
    ) {
      if (Math.abs(offset - index) <= 1) continue;
      background += rowMeans[offset];
      samples += 1;
    }
    const localBackground = background / Math.max(1, samples);
    const horizontalEdge = Math.abs(rowMeans[index + 1] - rowMeans[index - 1]);
    const darkBand = Math.max(0, localBackground - rowMeans[index]);
    scores[index] = horizontalEdge + darkBand * 1.25;
  }

  const mean = scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
  const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, scores.length);
  const deviation = Math.sqrt(variance);
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let index = 1; index < scores.length - 1; index += 1) {
    if (scores[index] < scores[index - 1] || scores[index] < scores[index + 1]) continue;
    const y = top + index;
    const distancePenalty = Math.abs(y - centerY) / Math.max(1, tick.pitch) * deviation * 0.18;
    const score = scores[index] - distancePenalty;
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  gray.delete();

  if (bestIndex < 0) return null;
  const leftScore = scores[bestIndex - 1];
  const centerScore = scores[bestIndex];
  const rightScore = scores[bestIndex + 1];
  const denominator = leftScore - centerScore * 2 + rightScore;
  const subpixel = Math.abs(denominator) > 1e-6
    ? Math.max(-0.5, Math.min(0.5, 0.5 * (leftScore - rightScore) / denominator))
    : 0;
  const detectedY = top + bestIndex + subpixel;
  const confidence = Math.max(0, Math.min(1, (centerScore - mean) / Math.max(1, deviation * 3)));
  const manualDistance = manualMeniscusHintY === null
    ? 0
    : Math.abs(detectedY - manualMeniscusHintY);
  if (manualMeniscusHintY !== null && (confidence < 0.22 || manualDistance > tick.pitch * 1.7)) {
    return { y: manualMeniscusHintY, confidence: 0.58, usedManualAnchor: true };
  }
  return { y: detectedY, confidence, usedManualAnchor: false };
}

function estimateRollingScaleMotion(frame, geometry) {
  if (!rollingScaleTemplate || !rollingTemplateOrigin) {
    return { offsetY: 0, confidence: 1 };
  }
  const tracking = createTrackingGray(frame);
  const horizontalMargin = Math.max(8, Math.round(geometry.width));
  const verticalMargin = Math.round(frame.rows * 0.16);
  const expectedX = Math.round(geometry.centerX - rollingScaleTemplate.cols / 2);
  const searchX = Math.max(0, expectedX - horizontalMargin);
  const searchY = Math.max(0, rollingTemplateOrigin.y - verticalMargin);
  const searchWidth = Math.min(
    frame.cols - searchX,
    rollingScaleTemplate.cols + horizontalMargin * 2,
  );
  const searchHeight = Math.min(
    frame.rows - searchY,
    rollingScaleTemplate.rows + verticalMargin * 2,
  );
  if (searchWidth < rollingScaleTemplate.cols || searchHeight < rollingScaleTemplate.rows) {
    tracking.delete();
    return { offsetY: 0, confidence: 0 };
  }
  const search = tracking.roi(new cv.Rect(searchX, searchY, searchWidth, searchHeight));
  const result = new cv.Mat();
  cv.matchTemplate(search, rollingScaleTemplate, result, cv.TM_CCOEFF_NORMED);
  const match = cv.minMaxLoc(result);
  const offsetY = searchY + match.maxLoc.y - rollingTemplateOrigin.y;
  tracking.delete();
  search.delete();
  result.delete();
  return { offsetY, confidence: match.maxVal };
}

function captureRollingScaleReference(frame, geometry) {
  const tracking = createTrackingGray(frame);
  const width = Math.min(
    frame.cols,
    Math.max(32, Math.round(geometry.width * 3.6)),
  );
  const height = Math.max(48, Math.round(frame.rows * 0.42));
  const x = Math.max(0, Math.min(frame.cols - width, Math.round(geometry.centerX - width / 2)));
  const y = Math.max(0, Math.min(frame.rows - height, Math.round(frame.rows * 0.29)));
  rollingScaleTemplate?.delete();
  rollingScaleTemplate = tracking.roi(new cv.Rect(x, y, width, height)).clone();
  rollingTemplateOrigin = { x, y };
  tracking.delete();
}

function drawTrackingOverlay(frame, geometry, tick, meniscus, alignment, tubeRollDegrees = 0) {
  const cyan = new cv.Scalar(68, 166, 204, 255);
  const green = new cv.Scalar(94, 203, 137, 255);
  const yellow = new cv.Scalar(241, 200, 74, 255);
  const red = new cv.Scalar(225, 82, 82, 255);
  const qualityColor = alignment?.accepted ? green : red;
  const rollTangent = Math.tan(tubeRollDegrees * Math.PI / 180);
  const correctedY = (centerY, x) => centerY - rollTangent * (x - geometry.centerX);
  const roiHalfWidth = Math.round(geometry.width * 1.8);
  cv.rectangle(
    frame,
    new cv.Point(Math.max(0, geometry.centerX - roiHalfWidth), 1),
    new cv.Point(Math.min(frame.cols - 1, geometry.centerX + roiHalfWidth), frame.rows - 2),
    qualityColor,
    2,
  );
  cv.line(frame, new cv.Point(geometry.leftX, 0), new cv.Point(geometry.leftX, frame.rows), green, 2);
  cv.line(frame, new cv.Point(geometry.rightX, 0), new cv.Point(geometry.rightX, frame.rows), green, 2);
  for (let offset = -4; offset <= 4; offset += 1) {
    const centerY = meniscus.y + offset * tick.pitch;
    const leftX = geometry.centerX - geometry.width * 0.7;
    const rightX = geometry.centerX + geometry.width * 0.7;
    cv.line(
      frame,
      new cv.Point(leftX, correctedY(centerY, leftX)),
      new cv.Point(rightX, correctedY(centerY, rightX)),
      cyan,
      1,
    );
  }
  const meniscusLeftX = geometry.centerX - geometry.width;
  const meniscusRightX = geometry.centerX + geometry.width;
  cv.line(
    frame,
    new cv.Point(meniscusLeftX, correctedY(meniscus.y, meniscusLeftX)),
    new cv.Point(meniscusRightX, correctedY(meniscus.y, meniscusRightX)),
    yellow,
    3,
  );
  cv.line(
    frame,
    new cv.Point(0, frame.rows / 2),
    new cv.Point(frame.cols, frame.rows / 2),
    qualityColor,
    2,
  );
}

function opticalAlignmentMessage(alignment) {
  const reason = alignment?.reasons?.[0];
  const messages = {
    "meniscus-high": "시차 위험 · 휴대폰 렌즈 높이를 메니스커스와 맞추고 액면을 중앙 수평선으로 내려주세요.",
    "meniscus-low": "시차 위험 · 휴대폰 렌즈 높이를 메니스커스와 맞추고 액면을 중앙 수평선으로 올려주세요.",
    "camera-pitch": "굴절 위험 · 휴대폰을 위아래로 기울이지 말고 카메라 광축을 수평으로 맞춰주세요.",
    "tube-roll": "원근 왜곡 · 뷰렛 축이 화면 세로선과 평행하도록 휴대폰을 회전해주세요.",
    "tick-perspective": "굴절·시차 위험 · 상하 눈금 크기가 다릅니다. 렌즈 높이와 촬영 각도를 다시 맞춰주세요.",
    "tube-perspective": "원근 왜곡 · 관의 상하 폭이 다릅니다. 뷰렛 정면에서 수평으로 촬영해주세요.",
    "perspective-unavailable": "원근을 검증할 눈금과 관 벽이 부족합니다. 더 가까이에서 상하 눈금이 함께 보이게 해주세요.",
    "portrait-required": "정렬 검증을 위해 휴대폰을 세로 방향으로 돌려주세요.",
  };
  return messages[reason] ?? "광학 정렬을 확인하는 동안 측정을 보류합니다.";
}

async function recordVolume(timestamp) {
  if (currentVolume === null) return;
  const measurement = {
    id: createMeasurementId("burette"),
    timestamp,
    volume: roundBuretteReading(currentVolume),
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
  const rectified = sourceFrame.clone();
  if (tubeHintX === null) {
    cv.line(
      rectified,
      new cv.Point(rectified.cols / 2, rectified.rows * 0.18),
      new cv.Point(rectified.cols / 2, rectified.rows * 0.82),
      new cv.Scalar(241, 200, 74, 255),
      2,
    );
    cv.line(
      rectified,
      new cv.Point(rectified.cols * 0.18, rectified.rows / 2),
      new cv.Point(rectified.cols * 0.82, rectified.rows / 2),
      new cv.Scalar(241, 200, 74, 255),
      2,
    );
    if (!tutorialOpen) {
      calibrationStatus.textContent = "화면에서 메니스커스 가운데를 한 번 터치해주세요.";
    }
  } else {
    const geometry = locateTube(rectified);
    const perspective = geometry
      ? estimateTubePerspective(rectified, geometry)
      : null;
    const searchCenterY = manualMeniscusHintY ?? previousScaleObservation?.meniscusY ?? rectified.rows / 2;
    const tick = geometry
      ? estimateTickPitch(rectified, geometry, searchCenterY)
      : null;
    const movement = geometry
      ? estimateRollingScaleMotion(rectified, geometry)
      : { offsetY: 0, confidence: 0 };
    const scaleRatio = tick && previousScaleObservation
      ? tick.pitch / previousScaleObservation.tickPitch
      : 1;
    const predictedY = previousScaleObservation
      ? rectified.rows / 2 +
        (previousScaleObservation.meniscusY - previousScaleObservation.frameCenterY) * scaleRatio +
        movement.offsetY
      : manualMeniscusHintY;
    const tubeRollDegrees = perspective?.axisTiltDegrees ??
      (orientation.available ? orientation.gamma : 0);
    const detection = geometry && tick
      ? detectMeniscusInTube(rectified, geometry, tick, predictedY, tubeRollDegrees)
      : null;
    const screenAngle = Number(
      globalThis.screen?.orientation?.angle ?? globalThis.orientation ?? 0,
    );
    const alignment = detection
      ? evaluateOpticalAlignment({
          meniscusY: detection.y,
          frameHeight: rectified.rows,
          cameraPitchDegrees: orientation.available
            ? Math.abs(orientation.beta) - 90
            : Number.NaN,
          tubeRollDegrees,
          upperTickPitch: tick?.upperPitch,
          lowerTickPitch: tick?.lowerPitch,
          upperTubeWidth: perspective?.upperTubeWidth,
          lowerTubeWidth: perspective?.lowerTubeWidth,
          portrait: Math.abs(screenAngle) % 180 === 0,
          requirePerspective: true,
        })
      : null;
    const motionAccepted = !previousScaleObservation || movement.confidence >= 0.38;
    const qualityAccepted = Boolean(
      geometry &&
      geometry.width >= 12 &&
      tick &&
      tick.pitch >= 3 &&
      tick.confidence >= 0.16 &&
      detection &&
      detection.confidence >= 0.2 &&
      alignment?.accepted &&
      motionAccepted,
    );

    if (geometry && tick && detection) {
      drawTrackingOverlay(
        rectified,
        geometry,
        tick,
        detection,
        alignment,
        tubeRollDegrees,
      );
    }

    if (qualityAccepted) {
      const observation = {
        meniscusY: detection.y,
        tickPitch: tick.pitch,
        frameCenterY: rectified.rows / 2,
      };
      let relativeTicks = 0;
      if (previousScaleObservation) {
        relativeTicks = relativeMeniscusTicks(
          previousScaleObservation,
          observation,
          movement.offsetY,
        );
      }
      const plausibleMovement = relativeTicks !== null && Math.abs(relativeTicks) <= 1.5;
      if (!previousScaleObservation || plausibleMovement) {
        currentY = currentY ?? 0;
        if (previousScaleObservation) currentY += relativeTicks;
        previousScaleObservation = observation;
        manualMeniscusHintY = null;
        captureRollingScaleReference(rectified, geometry);
        const isStable = trackStableMeniscus(currentY);

        if (calibrationStage === "reanchor") {
          liveVolume.textContent = "--.-- mL";
          calibrationStatus.textContent = isStable
            ? "추적을 다시 고정했습니다. 현재 눈금값을 확인해주세요."
            : "추적 기준을 복원하는 중입니다. 화면을 잠시 안정시켜주세요.";
        } else if (calibration.scale !== null) {
          currentVolume = calibration.point1Volume + (currentY - calibration.point1Y) * calibration.scale;
          liveVolume.textContent = formatBuretteReading(currentVolume);
          calibrationStatus.textContent =
            `추적 고정 · 0.1 mL 눈금 ${tick.pitch.toFixed(1)} px · 0.01 mL까지 기록 중`;
          if (timestamp - lastMeasurementAt >= Number(sampleInterval.value)) {
            lastMeasurementAt = timestamp;
            recordVolume(Date.now());
          }
        } else if (calibrationStage === "waiting-second") {
          calibrationStatus.textContent =
            "추적 고정 · 액체를 3~5 mL 배출한 뒤 콕을 잠가주세요.";
        } else {
          calibrationStatus.textContent = isStable
            ? "메니스커스와 0.1 mL 눈금을 인식했습니다."
            : "추적 고정 중 · 화면을 잠시 안정시켜주세요.";
        }
        updateCalibrationTutorial(isStable);
      } else {
        stableMeniscusPoints.length = 0;
        calibrationStatus.textContent = "급격한 이동을 감지해 측정을 보류했습니다. 화면을 잠시 고정해주세요.";
      }
    } else if (!tutorialOpen) {
      stableMeniscusPoints.length = 0;
      if (!geometry || geometry.width < 12) {
        calibrationStatus.textContent = "뷰렛이 너무 작거나 벽이 흐립니다. 조금 가까이에서 메니스커스를 다시 터치해주세요.";
      } else if (!tick || tick.pitch < 3 || tick.confidence < 0.16) {
        calibrationStatus.textContent = "0.1 mL 눈금이 흐리거나 너무 작습니다. 초점을 맞추고 조금 가까이 이동해주세요.";
      } else if (!motionAccepted) {
        calibrationStatus.textContent = "카메라 흔들림이 큽니다. 추적을 잠시 보류하고 다시 고정되는 중입니다.";
      } else if (alignment && !alignment.accepted) {
        calibrationStatus.textContent = opticalAlignmentMessage(alignment);
      } else {
        calibrationStatus.textContent = "메니스커스를 찾지 못했습니다. 액면 가운데를 다시 터치해주세요.";
      }
    }
  }

  cv.imshow(canvas, rectified);
  canvas.classList.add("active");
  setCameraMessage(cameraMessage, "");
  rectified.delete();
  animationFrame = requestAnimationFrame(processFrame);
}

function canvasPointFromPointer(event) {
  const bounds = canvas.getBoundingClientRect();
  const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
  const renderedWidth = canvas.width * scale;
  const renderedHeight = canvas.height * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const x = (event.clientX - bounds.left - offsetX) / scale;
  const y = (event.clientY - bounds.top - offsetY) / scale;
  if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) return null;
  return { x, y };
}

function selectMeniscusFromPointer(event) {
  if (!sourceFrame || !canvas.classList.contains("active")) return;
  const point = canvasPointFromPointer(event);
  if (!point) return;
  const wasCalibrated = calibration.scale !== null;
  const wasWaitingSecond = calibrationStage === "waiting-second";
  tubeHintX = point.x;
  manualMeniscusHintY = point.y;
  trackedTubeGeometry = null;
  trackedTickPitch = null;
  previousScaleObservation = null;
  rollingScaleTemplate?.delete();
  rollingScaleTemplate = null;
  rollingTemplateOrigin = null;
  stableMeniscusPoints.length = 0;

  if (wasCalibrated) {
    calibrationStage = "reanchor";
    calibrationStatus.textContent = "뷰렛을 다시 찾았습니다. 안정되면 현재 눈금값을 확인합니다.";
  } else if (wasWaitingSecond) {
    Object.assign(calibration, {
      point1Y: null,
      point1Volume: null,
      point2Y: null,
      point2Volume: null,
      scale: null,
    });
    currentY = 0;
    currentVolume = null;
    calibrationStage = "waiting-first";
    calibrationStatus.textContent = "추적 기준이 바뀌어 첫 번째 눈금부터 다시 확인합니다.";
  } else {
    currentY = 0;
    calibrationStatus.textContent = "터치한 위치에서 뷰렛 벽과 0.1 mL 눈금을 찾는 중입니다.";
  }
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
introConfirm.addEventListener("click", () => {
  tutorialOpen = false;
  introDialog.close();
  calibrationStatus.textContent = "화면에서 메니스커스 가운데를 한 번 터치해주세요.";
});
calibrationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const actualVolume = Number(actualVolumeInput.value);
  if (!Number.isFinite(actualVolume) || currentY === null) return;
  if (calibrationStage === "waiting-first") {
    calibration.point1Y = currentY;
    calibration.point1Volume = actualVolume;
    calibrationStage = "waiting-second";
    calibrationStatus.textContent = "콕을 열어 액체를 3~5 mL 정도 배출한 뒤 다시 잠가주세요.";
  } else if (calibrationStage === "waiting-second") {
    calibration.point2Y = currentY;
    calibration.point2Volume = actualVolume;
    updateCalibration();
    if (
      calibration.scale === null ||
      Math.abs(actualVolume - calibration.point1Volume) < 0.1 ||
      Math.abs(calibration.scale) < 0.06 ||
      Math.abs(calibration.scale) > 0.14
    ) {
      calibration.point2Y = null;
      calibration.point2Volume = null;
      calibration.scale = null;
      calibrationStatus.textContent =
        "검출된 눈금 간격과 입력값이 맞지 않습니다. 초점을 확인한 뒤 두 번째 눈금을 다시 측정해주세요.";
    } else {
      calibrationStage = "complete";
      currentVolume = actualVolume;
      liveVolume.textContent = formatBuretteReading(currentVolume);
      completionDialog.showModal();
    }
  } else if (calibrationStage === "reanchor") {
    calibration.point1Y = currentY;
    calibration.point1Volume = actualVolume;
    currentVolume = actualVolume;
    liveVolume.textContent = formatBuretteReading(currentVolume);
    calibrationStage = "complete";
    calibrationStatus.textContent = "추적 기준 복원 완료 · 0.01 mL까지 기록하고 있습니다.";
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
canvas.addEventListener("pointerup", selectMeniscusFromPointer);
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
  rollingScaleTemplate?.delete();
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