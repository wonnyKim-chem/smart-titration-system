import { createMeasurementId } from "./offline-store.js";
import { ReliableMeasurementSocket } from "./reliable-socket.js";

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
const startButton = document.querySelector("#startCamera");
const thresholdInput = document.querySelector("#threshold");
const thresholdLabel = document.querySelector("#thresholdLabel");
const digitCountInput = document.querySelector("#digitCount");
const sampleInterval = document.querySelector("#sampleInterval");
const darkDigitsButton = document.querySelector("#darkDigits");
const lightDigitsButton = document.querySelector("#lightDigits");
const livePh = document.querySelector("#livePh");
const rawReading = document.querySelector("#rawReading");
const confidenceOutput = document.querySelector("#confidence");
const contourCountOutput = document.querySelector("#contourCount");
const visionStatus = document.querySelector("#visionStatus");
const networkStatus = document.querySelector("#networkStatus");
const roiInputs = ["roiX", "roiY", "roiWidth", "roiHeight"].map((id) =>
  document.querySelector(`#${id}`),
);

let cameraCapture = null;
let sourceFrame = null;
let animationFrame = null;
let lastMeasurementAt = 0;
let useDarkDigits = true;
const recentReadings = [];

const socket = new ReliableMeasurementSocket("ph", (connected) => {
  networkStatus.textContent = connected ? "서버 연결됨" : "오프라인 저장";
  networkStatus.classList.toggle("online", connected);
});
socket.connect();

function waitForOpenCv() {
  return new Promise((resolve) => {
    const check = () => {
      if (globalThis.cv?.Mat) {
        visionStatus.textContent = "준비";
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

function loadRoiSettings() {
  const saved = JSON.parse(localStorage.getItem("titration-ph-roi") ?? "null");
  if (saved) roiInputs.forEach((input) => (input.value = saved[input.id] ?? input.value));
  updateRoiLabels();
}

function updateRoiLabels() {
  const settings = {};
  for (const input of roiInputs) {
    document.querySelector(`#${input.id}Label`).textContent = input.value;
    settings[input.id] = Number(input.value);
  }
  localStorage.setItem("titration-ph-roi", JSON.stringify(settings));
}

function getRoi(frame) {
  const [xPercent, yPercent, widthPercent, heightPercent] = roiInputs.map((input) =>
    Number(input.value),
  );
  const x = Math.round((frame.cols * xPercent) / 100);
  const y = Math.round((frame.rows * yPercent) / 100);
  const width = Math.max(20, Math.min(Math.round((frame.cols * widthPercent) / 100), frame.cols - x));
  const height = Math.max(20, Math.min(Math.round((frame.rows * heightPercent) / 100), frame.rows - y));
  return new cv.Rect(x, y, width, height);
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

function readDisplay(binary) {
  const count = Number(digitCountInput.value);
  const integerDigits = count - 2;
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
  const numericText = `${digits.slice(0, integerDigits).join("")}.${digits.slice(integerDigits).join("")}`;
  const value = Number(numericText);
  return {
    value: Number.isFinite(value) && value >= 0 && value <= 14.5 ? value : null,
    confidence: confidences.reduce((sum, item) => sum + item, 0) / confidences.length,
  };
}

function stabiliseReading(value) {
  if (value === null) return null;
  recentReadings.push(value);
  if (recentReadings.length > 5) recentReadings.shift();
  if (recentReadings.length < 3) return null;
  const sorted = [...recentReadings].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const closeReadings = sorted.filter((item) => Math.abs(item - median) <= 0.03);
  return closeReadings.length >= 3 ? median : null;
}

async function recordPh(value, timestamp) {
  await socket.storeAndSend({
    id: createMeasurementId("ph"),
    timestamp,
    ph: Number(value.toFixed(2)),
  });
}

function processFrame(timestamp) {
  if (!cameraCapture || !sourceFrame) return;
  cameraCapture.read(sourceFrame);
  const displayFrame = sourceFrame.clone();
  const roiRectangle = getRoi(sourceFrame);
  const roi = sourceFrame.roi(roiRectangle);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const binary = new cv.Mat();
  cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  const thresholdMode = useDarkDigits ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY;
  cv.threshold(blurred, binary, Number(thresholdInput.value), 255, thresholdMode);

  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const reading = readDisplay(binary);
  const stableValue = stabiliseReading(reading.value);
  rawReading.textContent = reading.value === null ? "--.--" : reading.value.toFixed(2);
  confidenceOutput.textContent = `${Math.round(reading.confidence * 100)}%`;
  contourCountOutput.textContent = String(contours.size());

  cv.rectangle(
    displayFrame,
    new cv.Point(roiRectangle.x, roiRectangle.y),
    new cv.Point(roiRectangle.x + roiRectangle.width, roiRectangle.y + roiRectangle.height),
    new cv.Scalar(241, 200, 74, 255),
    3,
  );
  if (stableValue !== null) {
    livePh.textContent = `pH ${stableValue.toFixed(2)}`;
    if (timestamp - lastMeasurementAt >= Number(sampleInterval.value)) {
      lastMeasurementAt = timestamp;
      recordPh(stableValue, Date.now());
    }
  }

  cv.imshow(canvas, displayFrame);
  roi.delete();
  gray.delete();
  blurred.delete();
  binary.delete();
  kernel.delete();
  contours.delete();
  hierarchy.delete();
  displayFrame.delete();
  animationFrame = requestAnimationFrame(processFrame);
}

async function startCamera() {
  startButton.disabled = true;
  try {
    await waitForOpenCv();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    sourceFrame = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
    cameraCapture = new cv.VideoCapture(video);
    startButton.querySelector("span").textContent = "카메라 실행 중";
    animationFrame = requestAnimationFrame(processFrame);
  } catch (error) {
    startButton.disabled = false;
    startButton.querySelector("span").textContent = "카메라 다시 시작";
    visionStatus.textContent = error.name === "NotAllowedError" ? "권한 필요" : "오류";
  }
}

function setPolarity(dark) {
  useDarkDigits = dark;
  darkDigitsButton.classList.toggle("active", dark);
  lightDigitsButton.classList.toggle("active", !dark);
}

startButton.addEventListener("click", startCamera);
darkDigitsButton.addEventListener("click", () => setPolarity(true));
lightDigitsButton.addEventListener("click", () => setPolarity(false));
thresholdInput.addEventListener("input", () => (thresholdLabel.textContent = thresholdInput.value));
roiInputs.forEach((input) => input.addEventListener("input", updateRoiLabels));
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationFrame);
  sourceFrame?.delete();
  video.srcObject?.getTracks().forEach((track) => track.stop());
  socket.stop();
});

loadRoiSettings();
waitForOpenCv();
globalThis.addEventListener("load", () => globalThis.lucide?.createIcons());