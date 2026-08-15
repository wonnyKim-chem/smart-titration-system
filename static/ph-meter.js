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

const SEGMENT_PATTERNS = {
  0: [1, 1, 1, 1, 1, 1, 0],
  1: [0, 1, 1, 0, 0, 0, 0],
  2: [1, 1, 0, 1, 1, 0, 1],
  3: [1, 1, 1, 1, 0, 0, 1],
  4: [0, 1, 1, 0, 0, 1, 1],
  5: [1, 0, 1, 1, 0, 1, 1],
  6: [1, 0, 1, 1, 1, 1, 1],
  7: [1, 1, 1, 0, 0, 0, 0],
  8: [1, 1, 1, 1, 1, 1, 1],
  9: [1, 1, 1, 1, 0, 1, 1],
};

const video = document.querySelector("#camera");
const canvas = document.querySelector("#processedFrame");
const cameraStage = document.querySelector("#cameraStage");
const cameraMessage = document.querySelector("#cameraMessage");
const startButton = document.querySelector("#startCamera");
const addMeasurementRegionButton = document.querySelector("#addMeasurementRegion");
const emptyRegions = document.querySelector("#emptyRegions");
const removePhRegionButton = document.querySelector("#removePhRegion");
const removeTemperatureRegionButton = document.querySelector("#removeTemperatureRegion");
const selectionStatus = document.querySelector("#selectionStatus");
const digitCountInput = document.querySelector("#digitCount");
const temperatureDigitCountInput = document.querySelector("#temperatureDigitCount");
const sampleInterval = document.querySelector("#sampleInterval");
const livePh = document.querySelector("#livePh");
const liveTemperature = document.querySelector("#liveTemperature");
const visionStatus = document.querySelector("#visionStatus");
const networkStatus = document.querySelector("#networkStatus");
const measurementTypeDialog = document.querySelector("#measurementTypeDialog");
const choosePhButton = document.querySelector("#choosePh");
const chooseDigitalTemperatureButton = document.querySelector("#chooseDigitalTemperature");
const chooseAnalogTemperatureButton = document.querySelector("#chooseAnalogTemperature");
const cancelMeasurementTypeButton = document.querySelector("#cancelMeasurementType");
const analogCalibrationDialog = document.querySelector("#analogCalibrationDialog");
const analogCalibrationForm = document.querySelector("#analogCalibrationForm");
const analogCalibrationStep = document.querySelector("#analogCalibrationStep");
const analogCalibrationTitle = document.querySelector("#analogCalibrationTitle");
const analogCalibrationPrompt = document.querySelector("#analogCalibrationPrompt");
const analogCalibrationValue = document.querySelector("#analogCalibrationValue");
const saveAnalogCalibrationButton = document.querySelector("#saveAnalogCalibration");
const cancelAnalogCalibrationButton = document.querySelector("#cancelAnalogCalibration");
const analogSuggestionDialog = document.querySelector("#analogSuggestionDialog");
const switchToAnalogButton = document.querySelector("#switchToAnalog");
const keepDigitalTemperatureButton = document.querySelector("#keepDigitalTemperature");

let cameraCapture = null;
let sourceFrame = null;
let animationFrame = null;
let lastMeasurementAt = 0;
let lastTemperatureMeasurementAt = 0;
let lastProcessedAt = 0;
let displayRegion = JSON.parse(localStorage.getItem("titration-ph-display-region") ?? "null");
let temperatureRegion = JSON.parse(localStorage.getItem("titration-temperature-display-region") ?? "null");
let temperatureMode = localStorage.getItem("titration-temperature-mode") ?? "digital";
let analogCalibration = JSON.parse(localStorage.getItem("titration-analog-temperature-calibration") ?? "null");
let pendingRegion = null;
let regionSelectionArmed = false;
let analogCalibrationStage = 0;
let pendingAnalogPointY = null;
let analogSuggestionShown = false;
let trackingFrameCount = 0;
let failedReadingFrames = 0;
let failedTemperatureFrames = 0;
const recentReadings = [];
const recentTemperatureReadings = [];
const recorder = createCameraRecorder("ph");

const socket = new ReliableMeasurementSocket("ph", (connected) => {
  networkStatus.textContent = connected ? "서버 연결됨" : "오프라인 저장";
  networkStatus.classList.toggle("online", connected);
});
socket.connect();
const temperatureSocket = new ReliableMeasurementSocket("temperature");
temperatureSocket.connect();

function updateConfiguredRegions() {
  removePhRegionButton.classList.toggle("hidden", !displayRegion);
  removeTemperatureRegionButton.classList.toggle("hidden", !temperatureRegion);
  emptyRegions.classList.toggle("hidden", Boolean(displayRegion || temperatureRegion));
  livePh.classList.toggle("hidden", !displayRegion);
  liveTemperature.classList.toggle("hidden", !temperatureRegion);
  removeTemperatureRegionButton.firstChild.textContent = temperatureMode === "analog"
    ? "아날로그 온도 영역 "
    : "디지털 온도 영역 ";
}

function getRoi(frame, region = displayRegion) {
  if (!region) return null;
  const x = Math.round(frame.cols * region.x);
  const y = Math.round(frame.rows * region.y);
  const width = Math.max(20, Math.min(Math.round(frame.cols * region.width), frame.cols - x));
  const height = Math.max(20, Math.min(Math.round(frame.rows * region.height), frame.rows - y));
  return new cv.Rect(x, y, width, height);
}

function setDisplayRegion(rectangle, frame, resetReadings = true) {
  const nextRegion = {
    x: rectangle.x / frame.cols,
    y: rectangle.y / frame.rows,
    width: rectangle.width / frame.cols,
    height: rectangle.height / frame.rows,
  };
  displayRegion = resetReadings || !displayRegion
    ? nextRegion
    : {
        x: displayRegion.x * 0.7 + nextRegion.x * 0.3,
        y: displayRegion.y * 0.7 + nextRegion.y * 0.3,
        width: displayRegion.width * 0.7 + nextRegion.width * 0.3,
        height: displayRegion.height * 0.7 + nextRegion.height * 0.3,
      };
  localStorage.setItem("titration-ph-display-region", JSON.stringify(displayRegion));
  if (resetReadings) recentReadings.length = 0;
  updateConfiguredRegions();
  if (resetReadings) selectionStatus.textContent = "LCD 영역을 찾았습니다. 숫자를 읽는 중입니다.";
}

function setTemperatureRegion(rectangle, frame, resetReadings = true) {
  const nextRegion = {
    x: rectangle.x / frame.cols,
    y: rectangle.y / frame.rows,
    width: rectangle.width / frame.cols,
    height: rectangle.height / frame.rows,
  };
  temperatureRegion = resetReadings || !temperatureRegion
    ? nextRegion
    : {
        x: temperatureRegion.x * 0.7 + nextRegion.x * 0.3,
        y: temperatureRegion.y * 0.7 + nextRegion.y * 0.3,
        width: temperatureRegion.width * 0.7 + nextRegion.width * 0.3,
        height: temperatureRegion.height * 0.7 + nextRegion.height * 0.3,
      };
  localStorage.setItem("titration-temperature-display-region", JSON.stringify(temperatureRegion));
  if (resetReadings) {
    recentTemperatureReadings.length = 0;
    failedTemperatureFrames = 0;
    selectionStatus.textContent = "온도계 영역을 찾았습니다. pH와 온도를 함께 읽는 중입니다.";
  }
  updateConfiguredRegions();
}

function findDisplayAroundPoint(frame, pointX, pointY, allowFallback = true) {
  const gray = new cv.Mat();
  const equalized = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  cv.equalizeHist(gray, equalized);
  cv.GaussianBlur(equalized, blurred, new cv.Size(7, 7), 0);
  cv.Canny(blurred, edges, 30, 100);
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  let selected = null;
  let selectedScore = -Infinity;
  for (let index = 0; index < contours.size(); index += 1) {
    const contour = contours.get(index);
    const bounds = cv.boundingRect(contour);
    contour.delete();
    const areaRatio = (bounds.width * bounds.height) / (frame.cols * frame.rows);
    const aspectRatio = bounds.width / Math.max(bounds.height, 1);
    if (areaRatio < 0.015 || areaRatio > 0.72 || aspectRatio < 1.25 || aspectRatio > 6.5) continue;
    const containsPoint =
      pointX >= bounds.x && pointX <= bounds.x + bounds.width && pointY >= bounds.y && pointY <= bounds.y + bounds.height;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const distance = Math.hypot(centerX - pointX, centerY - pointY);
    const score = (containsPoint ? frame.cols * 2 : 0) + bounds.width - distance * 0.8;
    if (score > selectedScore) {
      selected = bounds;
      selectedScore = score;
    }
  }

  gray.delete();
  equalized.delete();
  blurred.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  if (selected) {
    const paddingX = Math.round(selected.width * 0.04);
    const paddingY = Math.round(selected.height * 0.08);
    return new cv.Rect(
      Math.max(0, selected.x - paddingX),
      Math.max(0, selected.y - paddingY),
      Math.min(frame.cols - Math.max(0, selected.x - paddingX), selected.width + paddingX * 2),
      Math.min(frame.rows - Math.max(0, selected.y - paddingY), selected.height + paddingY * 2),
    );
  }

  if (!allowFallback) return null;

  const fallbackWidth = Math.round(frame.cols * 0.58);
  const fallbackHeight = Math.round(frame.rows * 0.3);
  return new cv.Rect(
    Math.max(0, Math.min(frame.cols - fallbackWidth, Math.round(pointX - fallbackWidth / 2))),
    Math.max(0, Math.min(frame.rows - fallbackHeight, Math.round(pointY - fallbackHeight / 2))),
    fallbackWidth,
    fallbackHeight,
  );
}

function trackDisplayRegion(frame, force = false) {
  if (!displayRegion) return false;
  trackingFrameCount += 1;
  if (!force && trackingFrameCount % 15 !== 0) return true;
  const current = getRoi(frame);
  if (!current) return false;
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  const candidate = findDisplayAroundPoint(frame, centerX, centerY, false);
  if (!candidate) return false;

  const candidateCenterX = candidate.x + candidate.width / 2;
  const candidateCenterY = candidate.y + candidate.height / 2;
  const distance = Math.hypot(candidateCenterX - centerX, candidateCenterY - centerY);
  const sizeRatio = candidate.width / Math.max(current.width, 1);
  if (distance > Math.max(current.width, current.height) * 1.4 || sizeRatio < 0.55 || sizeRatio > 1.8) {
    return false;
  }
  setDisplayRegion(candidate, frame, false);
  return true;
}

function trackTemperatureRegion(frame) {
  if (!temperatureRegion || temperatureMode === "analog" || trackingFrameCount % 15 !== 0) return;
  const current = getRoi(frame, temperatureRegion);
  if (!current) return;
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  const candidate = findDisplayAroundPoint(frame, centerX, centerY, false);
  if (!candidate) return;
  const candidateCenterX = candidate.x + candidate.width / 2;
  const candidateCenterY = candidate.y + candidate.height / 2;
  const distance = Math.hypot(candidateCenterX - centerX, candidateCenterY - centerY);
  if (distance <= Math.max(current.width, current.height) * 1.4) {
    setTemperatureRegion(candidate, frame, false);
  }
}

function inspectImageQuality(gray) {
  const mean = new cv.Mat();
  const standardDeviation = new cv.Mat();
  const laplacian = new cv.Mat();
  const laplacianMean = new cv.Mat();
  const laplacianDeviation = new cv.Mat();
  cv.meanStdDev(gray, mean, standardDeviation);
  cv.Laplacian(gray, laplacian, cv.CV_64F);
  cv.meanStdDev(laplacian, laplacianMean, laplacianDeviation);
  const brightness = mean.data64F[0];
  const contrast = standardDeviation.data64F[0];
  const sharpness = laplacianDeviation.data64F[0] ** 2;
  mean.delete();
  standardDeviation.delete();
  laplacian.delete();
  laplacianMean.delete();
  laplacianDeviation.delete();
  return {
    usable: brightness >= 22 && brightness <= 238 && contrast >= 10 && sharpness >= 14,
    brightness,
    sharpness,
  };
}

function segmentOccupancy(binary, rectangle) {
  const x = Math.max(0, Math.min(binary.cols - 1, Math.round(rectangle[0] * binary.cols)));
  const y = Math.max(0, Math.min(binary.rows - 1, Math.round(rectangle[1] * binary.rows)));
  const width = Math.max(1, Math.min(binary.cols - x, Math.round(rectangle[2] * binary.cols)));
  const height = Math.max(1, Math.min(binary.rows - y, Math.round(rectangle[3] * binary.rows)));
  const segment = binary.roi(new cv.Rect(x, y, width, height));
  const occupancy = cv.countNonZero(segment) / (width * height);
  segment.delete();
  return occupancy;
}

function recogniseDigit(digitImage) {
  const segmentAreas = [
    [0.23, 0.02, 0.54, 0.16],
    [0.72, 0.12, 0.25, 0.35],
    [0.72, 0.53, 0.25, 0.35],
    [0.23, 0.82, 0.54, 0.16],
    [0.03, 0.53, 0.25, 0.35],
    [0.03, 0.12, 0.25, 0.35],
    [0.23, 0.42, 0.54, 0.16],
  ];
  const occupancy = segmentAreas.map((area) => segmentOccupancy(digitImage, area));
  const active = occupancy.map((value) => (value >= 0.2 ? 1 : 0));
  let bestDigit = null;
  let bestDistance = Infinity;

  for (const [digit, pattern] of Object.entries(SEGMENT_PATTERNS)) {
    const distance = pattern.reduce((total, expected, index) => total + Math.abs(expected - active[index]), 0);
    if (distance < bestDistance) {
      bestDigit = digit;
      bestDistance = distance;
    }
  }
  return { digit: bestDistance <= 2 ? bestDigit : null, confidence: 1 - bestDistance / 7 };
}

function readDisplay(binary, count = Number(digitCountInput.value), decimalPlaces = 2) {
  const integerDigits = count - decimalPlaces;
  const decimalGap = Math.round(binary.cols * 0.07);
  const digitWidth = (binary.cols - decimalGap) / count;
  const digits = [];
  const confidences = [];

  for (let index = 0; index < count; index += 1) {
    const gapOffset = index >= integerDigits ? decimalGap : 0;
    const x = Math.max(0, Math.round(index * digitWidth + gapOffset));
    const nextGapOffset = index + 1 >= integerDigits ? decimalGap : 0;
    const nextX = Math.min(binary.cols, Math.round((index + 1) * digitWidth + nextGapOffset));
    const digitImage = binary.roi(new cv.Rect(x, 0, Math.max(1, nextX - x), binary.rows));
    const result = recogniseDigit(digitImage);
    digitImage.delete();
    digits.push(result.digit);
    confidences.push(result.confidence);
  }

  if (digits.some((digit) => digit === null)) return { value: null, confidence: 0 };
  const numericText = decimalPlaces > 0
    ? `${digits.slice(0, integerDigits).join("")}.${digits.slice(integerDigits).join("")}`
    : digits.join("");
  const value = Number(numericText);
  return {
    value: Number.isFinite(value) ? value : null,
    confidence: confidences.reduce((sum, item) => sum + item, 0) / confidences.length,
  };
}

function stabiliseReading(value) {
  if (value === null) {
    failedReadingFrames += 1;
    if (failedReadingFrames >= 8) recentReadings.length = 0;
    return null;
  }
  recentReadings.push(value);
  if (recentReadings.length > 5) recentReadings.shift();
  if (recentReadings.length < 3) return null;
  const sorted = [...recentReadings].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const closeReadings = sorted.filter((item) => Math.abs(item - median) <= 0.03);
  if (closeReadings.length < 3) {
    failedReadingFrames += 1;
    return null;
  }
  failedReadingFrames = 0;
  return median;
}

function stabiliseTemperature(value) {
  if (value === null || value < -100 || value > 300) {
    failedTemperatureFrames += 1;
    if (failedTemperatureFrames >= 8) recentTemperatureReadings.length = 0;
    return null;
  }
  recentTemperatureReadings.push(value);
  if (recentTemperatureReadings.length > 5) recentTemperatureReadings.shift();
  if (recentTemperatureReadings.length < 3) return null;
  const sorted = [...recentTemperatureReadings].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const closeReadings = sorted.filter((item) => Math.abs(item - median) <= 0.3);
  if (closeReadings.length < 3) {
    failedTemperatureFrames += 1;
    return null;
  }
  failedTemperatureFrames = 0;
  return median;
}

function detectAnalogColumn(frame, rectangle) {
  const xStart = Math.round(rectangle.x + rectangle.width * 0.28);
  const xEnd = Math.round(rectangle.x + rectangle.width * 0.72);
  const rowScores = [];
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
    let coloredPixels = 0;
    for (let x = xStart; x < xEnd; x += 2) {
      const offset = (y * frame.cols + x) * 4;
      const red = frame.data[offset];
      const green = frame.data[offset + 1];
      const blue = frame.data[offset + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
      const brightness = (red + green + blue) / 3;
      if ((saturation > 0.28 && brightness < 235) || brightness < 75) coloredPixels += 1;
    }
    rowScores.push(coloredPixels);
  }
  const minimumScore = Math.max(2, Math.round((xEnd - xStart) * 0.025));
  for (let index = 0; index < rowScores.length - 8; index += 1) {
    const supportingRows = rowScores.slice(index, index + 9).filter((score) => score >= minimumScore).length;
    if (supportingRows >= 6) {
      return {
        normalisedY: index / Math.max(1, rectangle.height - 1),
        confidence: Math.min(1, rowScores[index] / Math.max(minimumScore * 4, 1)),
      };
    }
  }
  return null;
}

function analogTemperatureFromPosition(normalisedY) {
  if (!analogCalibration?.point1 || !analogCalibration?.point2) return null;
  const deltaY = analogCalibration.point2.y - analogCalibration.point1.y;
  if (Math.abs(deltaY) < 0.02) return null;
  const scale = (analogCalibration.point2.temperature - analogCalibration.point1.temperature) / deltaY;
  return analogCalibration.point1.temperature + (normalisedY - analogCalibration.point1.y) * scale;
}

function beginAnalogCalibration() {
  if (!temperatureRegion) return;
  temperatureMode = "analog";
  localStorage.setItem("titration-temperature-mode", temperatureMode);
  analogCalibration = null;
  localStorage.removeItem("titration-analog-temperature-calibration");
  analogCalibrationStage = 1;
  pendingAnalogPointY = null;
  selectionStatus.textContent = "아날로그 보정 1/2 · 실제 값을 아는 첫 번째 눈금 위치를 화면에서 터치하세요.";
  setCameraMessage(cameraMessage, "첫 번째 기준 눈금 위치를 터치하세요.");
  updateConfiguredRegions();
}

function captureAnalogCalibrationPoint(pointY, rectangle) {
  if (!analogCalibrationStage || !rectangle) return false;
  if (pointY < rectangle.y || pointY > rectangle.y + rectangle.height) return false;
  pendingAnalogPointY = (pointY - rectangle.y) / rectangle.height;
  analogCalibrationStep.textContent = `아날로그 온도계 보정 ${analogCalibrationStage}/2`;
  analogCalibrationTitle.textContent = analogCalibrationStage === 1
    ? "첫 번째 눈금의 온도를 입력하세요"
    : "두 번째 눈금의 온도를 입력하세요";
  analogCalibrationPrompt.textContent = "방금 터치한 눈금이 나타내는 실제 온도를 입력해주세요.";
  analogCalibrationValue.value = analogCalibrationStage === 1 ? "0.0" : "50.0";
  saveAnalogCalibrationButton.disabled = false;
  analogCalibrationDialog.showModal();
  requestAnimationFrame(() => analogCalibrationValue.select());
  return true;
}

async function recordPh(value, timestamp) {
  await socket.storeAndSend({
    id: createMeasurementId("ph"),
    timestamp,
    ph: Number(value.toFixed(2)),
  });
}

async function recordTemperature(value, timestamp) {
  await temperatureSocket.storeAndSend({
    id: createMeasurementId("temperature"),
    timestamp,
    temperature: Number(value.toFixed(1)),
  });
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
    selectionStatus.textContent = "카메라 영상을 다시 연결하는 중입니다.";
    ensureFrameDimensions();
    animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  trackDisplayRegion(sourceFrame, failedReadingFrames >= 10);
  if (temperatureRegion) trackTemperatureRegion(sourceFrame);
  const displayFrame = sourceFrame.clone();
  const roiRectangle = getRoi(sourceFrame);
  if (roiRectangle) {
    const roi = sourceFrame.roi(roiRectangle);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const darkBinary = new cv.Mat();
    const lightBinary = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    const imageQuality = inspectImageQuality(gray);
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
    cv.threshold(blurred, darkBinary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    cv.threshold(blurred, lightBinary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    cv.morphologyEx(darkBinary, darkBinary, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(lightBinary, lightBinary, cv.MORPH_CLOSE, kernel);

    const darkReading = readDisplay(darkBinary);
    const lightReading = readDisplay(lightBinary);
    const reading = darkReading.confidence >= lightReading.confidence ? darkReading : lightReading;
    const acceptedValue = imageQuality.usable && reading.confidence >= 0.68 && reading.value <= 14.5
      ? reading.value
      : null;
    const stableValue = stabiliseReading(acceptedValue);

    cv.rectangle(
      displayFrame,
      new cv.Point(roiRectangle.x, roiRectangle.y),
      new cv.Point(roiRectangle.x + roiRectangle.width, roiRectangle.y + roiRectangle.height),
      new cv.Scalar(241, 200, 74, 255),
      3,
    );
    if (stableValue !== null) {
      livePh.textContent = `pH ${stableValue.toFixed(2)}`;
      if (!analogCalibrationStage) selectionStatus.textContent = `pH ${stableValue.toFixed(2)} 인식 중`;
      if (timestamp - lastMeasurementAt >= Number(sampleInterval.value)) {
        lastMeasurementAt = timestamp;
        recordPh(stableValue, Date.now());
      }
    } else if (!imageQuality.usable && !analogCalibrationStage) {
      selectionStatus.textContent = imageQuality.brightness < 22
        ? "화면이 너무 어둡습니다. LCD에 빛이 닿도록 조정해주세요."
        : imageQuality.brightness > 238
          ? "화면이 너무 밝습니다. 반사광을 피해 각도를 조정해주세요."
          : "화면이 흔들리거나 흐립니다. 잠시 고정하면 자동으로 다시 측정합니다.";
    } else if (failedReadingFrames >= 10 && !analogCalibrationStage) {
      selectionStatus.textContent = "LCD 위치를 다시 찾는 중입니다. 숫자 화면을 카메라 안에 유지해주세요.";
    } else if (!analogCalibrationStage) {
      selectionStatus.textContent = "숫자를 확인하는 중입니다. 잠시 고정해주세요.";
    }

    roi.delete();
    gray.delete();
    blurred.delete();
    darkBinary.delete();
    lightBinary.delete();
    kernel.delete();
  }

  const temperatureRectangle = getRoi(sourceFrame, temperatureRegion);
  if (temperatureRectangle) {
    let temperature = null;
    let analogDetection = null;
    if (temperatureMode === "analog") {
      analogDetection = detectAnalogColumn(sourceFrame, temperatureRectangle);
      temperature = stabiliseTemperature(
        analogDetection?.confidence >= 0.35
          ? analogTemperatureFromPosition(analogDetection.normalisedY)
          : null,
      );
    } else {
      const roi = sourceFrame.roi(temperatureRectangle);
      const gray = new cv.Mat();
      const blurred = new cv.Mat();
      const darkBinary = new cv.Mat();
      const lightBinary = new cv.Mat();
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
      const quality = inspectImageQuality(gray);
      cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
      cv.threshold(blurred, darkBinary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
      cv.threshold(blurred, lightBinary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.morphologyEx(darkBinary, darkBinary, cv.MORPH_CLOSE, kernel);
      cv.morphologyEx(lightBinary, lightBinary, cv.MORPH_CLOSE, kernel);
      const count = Number(temperatureDigitCountInput.value);
      const darkReading = readDisplay(darkBinary, count, 1);
      const lightReading = readDisplay(lightBinary, count, 1);
      const reading = darkReading.confidence >= lightReading.confidence ? darkReading : lightReading;
      temperature = stabiliseTemperature(
        quality.usable && reading.confidence >= 0.68 ? reading.value : null,
      );
      roi.delete();
      gray.delete();
      blurred.delete();
      darkBinary.delete();
      lightBinary.delete();
      kernel.delete();
      if (failedTemperatureFrames >= 20 && !analogSuggestionShown && !analogSuggestionDialog.open) {
        analogSuggestionShown = true;
        analogSuggestionDialog.showModal();
      }
    }

    cv.rectangle(
      displayFrame,
      new cv.Point(temperatureRectangle.x, temperatureRectangle.y),
      new cv.Point(
        temperatureRectangle.x + temperatureRectangle.width,
        temperatureRectangle.y + temperatureRectangle.height,
      ),
      new cv.Scalar(68, 166, 204, 255),
      3,
    );
    if (temperature !== null) {
      liveTemperature.textContent = `${temperature.toFixed(1)} °C`;
      if (timestamp - lastTemperatureMeasurementAt >= Number(sampleInterval.value)) {
        lastTemperatureMeasurementAt = timestamp;
        recordTemperature(temperature, Date.now());
      }
    } else if (temperatureMode === "analog" && !analogCalibration) {
      selectionStatus.textContent = "아날로그 온도계는 두 눈금 위치와 실제 온도로 먼저 보정해야 합니다.";
    }
  }

  cv.imshow(canvas, displayFrame);
  canvas.classList.add("active");
  if (displayRegion || temperatureRegion) {
    setCameraMessage(cameraMessage, "");
  } else {
    setCameraMessage(cameraMessage, "측정할 계측기 영역을 터치하세요.");
  }
  displayFrame.delete();
  animationFrame = requestAnimationFrame(processFrame);
}

async function startCamera() {
  startButton.disabled = true;
  setCameraMessage(cameraMessage, "카메라 권한과 영상을 확인하는 중입니다.");
  try {
    assertCameraSupport();
    await waitForOpenCv(visionStatus);
    const stream = await startEnvironmentCamera(video);
    recorder.attachStream(stream);
    ensureFrameDimensions();
    cameraCapture = new cv.VideoCapture(video);
    startButton.querySelector("span").textContent = "카메라 실행 중";
    selectionStatus.textContent = displayRegion || temperatureRegion
      ? "저장된 측정 영역을 확인하는 중입니다. 다른 계측기도 터치해 추가할 수 있습니다."
      : "카메라 화면에서 측정할 계측기 영역을 터치하세요.";
    addMeasurementRegionButton.disabled = false;
    animationFrame = requestAnimationFrame(processFrame);
  } catch (error) {
    startButton.disabled = false;
    startButton.querySelector("span").textContent = "카메라 다시 시작";
    visionStatus.textContent = error.name === "NotAllowedError" ? "권한 필요" : "오류";
    setCameraMessage(cameraMessage, describeCameraError(error), "error");
  }
}

startButton.addEventListener("click", startCamera);
cameraStage.addEventListener("pointerup", (event) => {
  if (!sourceFrame || !cameraCapture) return;
  const bounds = canvas.getBoundingClientRect();
  const pointX = ((event.clientX - bounds.left) / bounds.width) * sourceFrame.cols;
  const pointY = ((event.clientY - bounds.top) / bounds.height) * sourceFrame.rows;
  const temperatureRectangle = getRoi(sourceFrame, temperatureRegion);
  if (analogCalibrationStage && captureAnalogCalibrationPoint(pointY, temperatureRectangle)) {
    return;
  }
  pendingRegion = findDisplayAroundPoint(sourceFrame, pointX, pointY);
  regionSelectionArmed = false;
  measurementTypeDialog.showModal();
});
addMeasurementRegionButton.addEventListener("click", () => {
  regionSelectionArmed = true;
  selectionStatus.textContent = "추가할 계측기 화면을 카메라에서 터치하세요.";
  setCameraMessage(cameraMessage, "측정할 숫자 화면이나 온도계를 터치하세요.");
});
choosePhButton.addEventListener("click", () => {
  if (pendingRegion) setDisplayRegion(pendingRegion, sourceFrame);
  pendingRegion = null;
  measurementTypeDialog.close();
  selectionStatus.textContent = "pH 영역을 설정했습니다. 다른 계측기도 터치해 추가할 수 있습니다.";
});
chooseDigitalTemperatureButton.addEventListener("click", () => {
  if (pendingRegion) setTemperatureRegion(pendingRegion, sourceFrame);
  temperatureMode = "digital";
  analogCalibration = null;
  analogSuggestionShown = false;
  localStorage.setItem("titration-temperature-mode", temperatureMode);
  localStorage.removeItem("titration-analog-temperature-calibration");
  pendingRegion = null;
  measurementTypeDialog.close();
  selectionStatus.textContent = "디지털 온도 영역을 설정했습니다. 숫자를 읽는 중입니다.";
  updateConfiguredRegions();
});
chooseAnalogTemperatureButton.addEventListener("click", () => {
  if (pendingRegion) setTemperatureRegion(pendingRegion, sourceFrame);
  pendingRegion = null;
  measurementTypeDialog.close();
  beginAnalogCalibration();
});
cancelMeasurementTypeButton.addEventListener("click", () => {
  pendingRegion = null;
  measurementTypeDialog.close();
});
removePhRegionButton.addEventListener("click", () => {
  displayRegion = null;
  localStorage.removeItem("titration-ph-display-region");
  recentReadings.length = 0;
  failedReadingFrames = 0;
  livePh.textContent = "pH --.--";
  selectionStatus.textContent = temperatureRegion ? "온도만 측정 중입니다." : "측정할 계측기 영역을 터치하세요.";
  updateConfiguredRegions();
});
removeTemperatureRegionButton.addEventListener("click", () => {
  temperatureRegion = null;
  localStorage.removeItem("titration-temperature-display-region");
  recentTemperatureReadings.length = 0;
  failedTemperatureFrames = 0;
  liveTemperature.textContent = "--.- °C";
  analogCalibration = null;
  analogCalibrationStage = 0;
  localStorage.removeItem("titration-analog-temperature-calibration");
  selectionStatus.textContent = displayRegion ? "pH만 측정 중입니다." : "측정할 계측기 영역을 터치하세요.";
  updateConfiguredRegions();
});
analogCalibrationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const temperature = Number(analogCalibrationValue.value);
  if (!Number.isFinite(temperature) || pendingAnalogPointY === null) return;
  if (analogCalibrationStage === 1) {
    analogCalibration = { point1: { y: pendingAnalogPointY, temperature }, point2: null };
    analogCalibrationStage = 2;
    pendingAnalogPointY = null;
    analogCalibrationDialog.close();
    selectionStatus.textContent = "아날로그 보정 2/2 · 첫 눈금과 떨어진 두 번째 눈금 위치를 터치하세요.";
    setCameraMessage(cameraMessage, "두 번째 기준 눈금 위치를 터치하세요.");
  } else {
    analogCalibration.point2 = { y: pendingAnalogPointY, temperature };
    const valid = Math.abs(analogCalibration.point2.y - analogCalibration.point1.y) >= 0.08
      && Math.abs(analogCalibration.point2.temperature - analogCalibration.point1.temperature) >= 0.5;
    if (!valid) {
      analogCalibration.point2 = null;
      pendingAnalogPointY = null;
      analogCalibrationDialog.close();
      selectionStatus.textContent = "두 기준 눈금은 충분히 떨어져 있어야 합니다. 두 번째 눈금을 다시 터치하세요.";
      return;
    }
    localStorage.setItem("titration-analog-temperature-calibration", JSON.stringify(analogCalibration));
    analogCalibrationStage = 0;
    pendingAnalogPointY = null;
    analogCalibrationDialog.close();
    selectionStatus.textContent = "아날로그 온도계 보정 완료 · 액주 끝을 추적하고 있습니다.";
    setCameraMessage(cameraMessage, "");
  }
});
cancelAnalogCalibrationButton.addEventListener("click", () => {
  analogCalibrationStage = 0;
  pendingAnalogPointY = null;
  analogCalibrationDialog.close();
  selectionStatus.textContent = "아날로그 보정을 취소했습니다. 온도 영역을 다시 추가할 수 있습니다.";
});
switchToAnalogButton.addEventListener("click", () => {
  analogSuggestionDialog.close();
  beginAnalogCalibration();
});
keepDigitalTemperatureButton.addEventListener("click", () => {
  analogSuggestionDialog.close();
  failedTemperatureFrames = 0;
  selectionStatus.textContent = "디지털 온도 인식을 계속합니다. 숫자가 선명하게 보이도록 조정해주세요.";
});
[measurementTypeDialog, analogCalibrationDialog, analogSuggestionDialog].forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => event.preventDefault());
});
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationFrame);
  sourceFrame?.delete();
  video.srcObject?.getTracks().forEach((track) => track.stop());
  socket.stop();
  temperatureSocket.stop();
  recorder.dispose();
});

waitForOpenCv(visionStatus).catch(() => {
  visionStatus.textContent = "로드 실패";
});
updateConfiguredRegions();
if (!globalThis.isSecureContext) {
  setCameraMessage(cameraMessage, describeCameraError({ name: "InsecureContextError" }), "error");
  startButton.disabled = true;
}
globalThis.addEventListener("load", () => globalThis.lucide?.createIcons());