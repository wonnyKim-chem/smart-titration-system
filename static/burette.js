import { createMeasurementId } from "./offline-store.js";
import { ReliableMeasurementSocket } from "./reliable-socket.js";

const video = document.querySelector("#camera");
const canvas = document.querySelector("#processedFrame");
const startButton = document.querySelector("#startCamera");
const zeroButton = document.querySelector("#setZero");
const referenceButton = document.querySelector("#setReference");
const referenceInput = document.querySelector("#referenceVolume");
const thresholdInput = document.querySelector("#threshold");
const thresholdLabel = document.querySelector("#thresholdLabel");
const modeInput = document.querySelector("#detectionMode");
const sampleInterval = document.querySelector("#sampleInterval");
const currentYOutput = document.querySelector("#currentY");
const scaleOutput = document.querySelector("#scaleValue");
const orientationOutput = document.querySelector("#orientationValue");
const visionStatus = document.querySelector("#visionStatus");
const liveVolume = document.querySelector("#liveVolume");
const networkStatus = document.querySelector("#networkStatus");

const calibrationKey = "titration-burette-calibration";
const calibration = JSON.parse(localStorage.getItem(calibrationKey) ?? "null") ?? {
  zeroY: null,
  referenceY: null,
  referenceVolume: null,
  scale: null,
};

let currentY = null;
let currentVolume = null;
let cameraCapture = null;
let sourceFrame = null;
let animationFrame = null;
let lastMeasurementAt = 0;
const orientation = { beta: 0, gamma: 0 };

const socket = new ReliableMeasurementSocket("burette", (connected) => {
  networkStatus.textContent = connected ? "서버 연결됨" : "오프라인 저장";
  networkStatus.classList.toggle("online", connected);
});
socket.connect();

function saveCalibration() {
  localStorage.setItem(calibrationKey, JSON.stringify(calibration));
  scaleOutput.textContent = calibration.scale ? `${calibration.scale.toFixed(5)} mL/px` : "--";
}

function updateCalibration() {
  if (
    calibration.zeroY === null ||
    calibration.referenceY === null ||
    !calibration.referenceVolume ||
    calibration.referenceY === calibration.zeroY
  ) {
    calibration.scale = null;
  } else {
    calibration.scale =
      calibration.referenceVolume / Math.abs(calibration.referenceY - calibration.zeroY);
  }
  saveCalibration();
}

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

async function enableOrientation() {
  if (typeof DeviceOrientationEvent === "undefined") return;
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    const permission = await DeviceOrientationEvent.requestPermission();
    if (permission !== "granted") return;
  }
  window.addEventListener("deviceorientation", (event) => {
    orientation.beta = Number(event.beta ?? 0);
    orientation.gamma = Number(event.gamma ?? 0);
    orientationOutput.textContent = `${orientation.gamma.toFixed(1)}°`;
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
  const binary = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, filtered, new cv.Size(5, 5), 0);
  const threshold = Number(thresholdInput.value);
  if (modeInput.value === "canny") {
    cv.Canny(filtered, binary, threshold * 0.5, threshold * 1.5);
  } else {
    cv.threshold(filtered, binary, threshold, 255, cv.THRESH_BINARY_INV);
  }

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
  let bestContour = null;
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
      bestScore = score;
    }
    contour.delete();
  }

  let minimumY = null;
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
    bestContour.delete();
  }

  gray.delete();
  filtered.delete();
  binary.delete();
  contours.delete();
  hierarchy.delete();
  return minimumY;
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

function processFrame(timestamp) {
  if (!cameraCapture || !sourceFrame) return;
  cameraCapture.read(sourceFrame);
  const rectified = rectifyFrame(sourceFrame);
  currentY = detectMeniscus(rectified);

  if (currentY !== null) {
    currentYOutput.textContent = `${currentY.toFixed(1)} px`;
    zeroButton.disabled = false;
    referenceButton.disabled = false;
    if (calibration.scale !== null) {
      currentVolume = (currentY - calibration.zeroY) * calibration.scale;
      liveVolume.textContent = `${currentVolume.toFixed(2)} mL`;
      if (timestamp - lastMeasurementAt >= Number(sampleInterval.value)) {
        lastMeasurementAt = timestamp;
        recordVolume(Date.now());
      }
    }
  }

  cv.imshow(canvas, rectified);
  rectified.delete();
  animationFrame = requestAnimationFrame(processFrame);
}

async function startCamera() {
  startButton.disabled = true;
  try {
    await Promise.all([waitForOpenCv(), enableOrientation()]);
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

startButton.addEventListener("click", startCamera);
thresholdInput.addEventListener("input", () => {
  thresholdLabel.textContent = thresholdInput.value;
});
zeroButton.addEventListener("click", () => {
  calibration.zeroY = currentY;
  updateCalibration();
});
referenceButton.addEventListener("click", () => {
  calibration.referenceY = currentY;
  calibration.referenceVolume = Number(referenceInput.value);
  updateCalibration();
});
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationFrame);
  sourceFrame?.delete();
  video.srcObject?.getTracks().forEach((track) => track.stop());
  socket.stop();
});

saveCalibration();
waitForOpenCv();
globalThis.addEventListener("load", () => globalThis.lucide?.createIcons());