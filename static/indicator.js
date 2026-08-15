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
const cameraStage = document.querySelector("#cameraStage");
const cameraMessage = document.querySelector("#cameraMessage");
const startButton = document.querySelector("#startCamera");
const selectFlaskButton = document.querySelector("#selectFlask");
const baselineButton = document.querySelector("#setColorBaseline");
const colorStatus = document.querySelector("#colorStatus");
const liveDeltaColor = document.querySelector("#liveDeltaColor");
const liveRgb = document.querySelector("#liveRgb");
const visionStatus = document.querySelector("#visionStatus");
const networkStatus = document.querySelector("#networkStatus");

let cameraCapture = null;
let sourceFrame = null;
let animationFrame = null;
let lastProcessedAt = 0;
let lastMeasurementAt = 0;
let flaskRegion = JSON.parse(localStorage.getItem("titration-color-flask-region") ?? "null");
let baselineLab = null;
let currentColor = null;
let trackingFrames = 0;
const recentColors = [];
const recorder = createCameraRecorder("color");

const socket = new ReliableMeasurementSocket("color", (connected) => {
  networkStatus.textContent = connected ? "서버 연결됨" : "오프라인 저장";
  networkStatus.classList.toggle("online", connected);
});
socket.connect();

function median(values) {
  if (!values.length) return null;
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
}

function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const lightness = (maximum + minimum) / 2;
  const difference = maximum - minimum;
  if (difference === 0) return { hue: 0, saturation: 0, lightness: lightness * 100 };
  const saturation = difference / (1 - Math.abs(2 * lightness - 1));
  let hue = maximum === r
    ? ((g - b) / difference) % 6
    : maximum === g
      ? (b - r) / difference + 2
      : (r - g) / difference + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, saturation, lightness: lightness * 100 };
}

function rgbToLab(red, green, blue) {
  const linear = [red, green, blue].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047;
  const y = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883;
  const transform = (value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return { light: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function colorDistance(first, second) {
  if (!first || !second) return 0;
  return Math.hypot(first.light - second.light, first.a - second.a, first.b - second.b);
}

function getFlaskRectangle(frame) {
  if (!flaskRegion) return null;
  return new cv.Rect(
    Math.round(flaskRegion.x * frame.cols),
    Math.round(flaskRegion.y * frame.rows),
    Math.round(flaskRegion.width * frame.cols),
    Math.round(flaskRegion.height * frame.rows),
  );
}

function findFlaskAroundPoint(frame, pointX, pointY) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 0);
  cv.Canny(blurred, edges, 25, 85);
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  let selected = null;
  let score = -Infinity;
  for (let index = 0; index < contours.size(); index += 1) {
    const contour = contours.get(index);
    const bounds = cv.boundingRect(contour);
    contour.delete();
    const area = (bounds.width * bounds.height) / (frame.cols * frame.rows);
    const aspect = bounds.width / Math.max(bounds.height, 1);
    if (area < 0.03 || area > 0.75 || aspect < 0.55 || aspect > 2.2) continue;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const distance = Math.hypot(centerX - pointX, centerY - pointY);
    const contains = pointX >= bounds.x && pointX <= bounds.x + bounds.width && pointY >= bounds.y && pointY <= bounds.y + bounds.height;
    const candidateScore = (contains ? frame.cols : 0) + bounds.width - distance;
    if (candidateScore > score) {
      selected = bounds;
      score = candidateScore;
    }
  }
  gray.delete();
  blurred.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();
  if (selected) return selected;
  const width = Math.round(frame.cols * 0.5);
  const height = Math.round(frame.rows * 0.48);
  return new cv.Rect(
    Math.max(0, Math.min(frame.cols - width, Math.round(pointX - width / 2))),
    Math.max(0, Math.min(frame.rows - height, Math.round(pointY - height / 2))),
    width,
    height,
  );
}

function setFlaskRegion(rectangle, frame, smooth = false) {
  const next = {
    x: rectangle.x / frame.cols,
    y: rectangle.y / frame.rows,
    width: rectangle.width / frame.cols,
    height: rectangle.height / frame.rows,
  };
  flaskRegion = smooth && flaskRegion
    ? {
        x: flaskRegion.x * 0.75 + next.x * 0.25,
        y: flaskRegion.y * 0.75 + next.y * 0.25,
        width: flaskRegion.width * 0.75 + next.width * 0.25,
        height: flaskRegion.height * 0.75 + next.height * 0.25,
      }
    : next;
  localStorage.setItem("titration-color-flask-region", JSON.stringify(flaskRegion));
  baselineButton.disabled = false;
}

function estimateWhiteReference(frame, flaskRectangle) {
  const channels = [[], [], []];
  const data = frame.data;
  const step = 8;
  for (let y = 0; y < frame.rows; y += step) {
    for (let x = 0; x < frame.cols; x += step) {
      const insideFlask = flaskRectangle && x >= flaskRectangle.x && x <= flaskRectangle.x + flaskRectangle.width && y >= flaskRectangle.y && y <= flaskRectangle.y + flaskRectangle.height;
      if (insideFlask) continue;
      const offset = (y * frame.cols + x) * 4;
      const values = [data[offset], data[offset + 1], data[offset + 2]];
      const brightness = (values[0] + values[1] + values[2]) / 3;
      if (brightness < 120 || Math.max(...values) - Math.min(...values) > 35) continue;
      values.forEach((value, index) => channels[index].push(value));
    }
  }
  const white = channels.map((channel) => median(channel) ?? 230);
  return white.map((value) => Math.min(1.8, Math.max(0.7, 235 / Math.max(value, 1))));
}

function measureFlaskColor(frame, rectangle) {
  const scales = estimateWhiteReference(frame, rectangle);
  const channels = [[], [], []];
  const data = frame.data;
  const step = 3;
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += step) {
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += step) {
      const normalX = (x - rectangle.x) / rectangle.width;
      const normalY = (y - rectangle.y) / rectangle.height;
      const ellipse = ((normalX - 0.5) / 0.48) ** 2 + ((normalY - 0.5) / 0.46) ** 2;
      const vortex = Math.hypot(normalX - 0.5, normalY - 0.48) < 0.16;
      if (ellipse > 1 || vortex || normalY > 0.82) continue;
      const offset = (y * frame.cols + x) * 4;
      const raw = [data[offset], data[offset + 1], data[offset + 2]];
      const brightness = (raw[0] + raw[1] + raw[2]) / 3;
      if (brightness < 25 || brightness > 242) continue;
      raw.forEach((value, index) => channels[index].push(Math.min(255, value * scales[index])));
    }
  }
  if (channels[0].length < 120) return null;
  const rgb = channels.map((channel) => median(channel));
  const hsl = rgbToHsl(...rgb);
  const lab = rgbToLab(...rgb);
  return {
    red: rgb[0], green: rgb[1], blue: rgb[2],
    hue: hsl.hue, saturation: hsl.saturation, lightness: hsl.lightness,
    lab,
    deltaColor: colorDistance(lab, baselineLab),
    sampleCount: channels[0].length,
  };
}

function stabiliseColor(measurement) {
  if (!measurement) {
    recentColors.length = 0;
    return null;
  }
  recentColors.push(measurement);
  if (recentColors.length > 5) recentColors.shift();
  if (recentColors.length < 3) return null;
  const fields = ["red", "green", "blue", "hue", "saturation", "lightness", "deltaColor"];
  return {
    ...measurement,
    ...Object.fromEntries(fields.map((field) => [field, median(recentColors.map((item) => item[field]))])),
  };
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

async function recordColor(measurement) {
  await socket.storeAndSend({
    id: createMeasurementId("color"),
    timestamp: Date.now(),
    red: Number(measurement.red.toFixed(2)),
    green: Number(measurement.green.toFixed(2)),
    blue: Number(measurement.blue.toFixed(2)),
    hue: Number(measurement.hue.toFixed(3)),
    saturation: Number(measurement.saturation.toFixed(4)),
    lightness: Number(measurement.lightness.toFixed(3)),
    deltaColor: Number(measurement.deltaColor.toFixed(3)),
  });
}

function processFrame(timestamp) {
  if (!cameraCapture || !ensureFrameDimensions()) return;
  if (timestamp - lastProcessedAt < 100) {
    animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  lastProcessedAt = timestamp;
  try {
    cameraCapture.read(sourceFrame);
  } catch {
    sourceFrame?.delete();
    sourceFrame = null;
    animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  trackingFrames += 1;
  let rectangle = getFlaskRectangle(sourceFrame);
  if (rectangle && trackingFrames % 15 === 0) {
    const candidate = findFlaskAroundPoint(
      sourceFrame,
      rectangle.x + rectangle.width / 2,
      rectangle.y + rectangle.height / 2,
    );
    const distance = Math.hypot(candidate.x - rectangle.x, candidate.y - rectangle.y);
    if (distance < Math.max(rectangle.width, rectangle.height) * 0.5) {
      setFlaskRegion(candidate, sourceFrame, true);
      rectangle = getFlaskRectangle(sourceFrame);
    }
  }

  const displayFrame = sourceFrame.clone();
  if (rectangle) {
    const measurement = stabiliseColor(measureFlaskColor(sourceFrame, rectangle));
    cv.rectangle(
      displayFrame,
      new cv.Point(rectangle.x, rectangle.y),
      new cv.Point(rectangle.x + rectangle.width, rectangle.y + rectangle.height),
      new cv.Scalar(241, 200, 74, 255),
      3,
    );
    if (measurement) {
      currentColor = measurement;
      liveDeltaColor.textContent = `Δ색 ${measurement.deltaColor.toFixed(1)}`;
      liveRgb.textContent = `RGB ${Math.round(measurement.red)}, ${Math.round(measurement.green)}, ${Math.round(measurement.blue)}`;
      colorStatus.textContent = baselineLab
        ? `흰 종이 기준 보정 중 · 유효 색 픽셀 ${measurement.sampleCount.toLocaleString()}개`
        : "현재 색을 기준으로 버튼을 눌러 실험 시작 색을 저장하세요.";
      if (baselineLab && timestamp - lastMeasurementAt >= 500) {
        lastMeasurementAt = timestamp;
        recordColor(measurement);
      }
    } else {
      colorStatus.textContent = "반사광이나 방해물이 많습니다. 플라스크와 흰 종이가 넓게 보이도록 조정해주세요.";
    }
    setCameraMessage(cameraMessage, "");
  } else {
    setCameraMessage(cameraMessage, "플라스크 몸통 중앙을 한 번 터치하세요.");
  }
  cv.imshow(canvas, displayFrame);
  canvas.classList.add("active");
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
    selectFlaskButton.disabled = false;
    baselineButton.disabled = !flaskRegion;
    colorStatus.textContent = flaskRegion ? "저장된 플라스크 영역을 확인하는 중입니다." : "카메라 화면에서 플라스크 몸통 중앙을 터치하세요.";
    animationFrame = requestAnimationFrame(processFrame);
  } catch (error) {
    startButton.disabled = false;
    startButton.querySelector("span").textContent = "카메라 다시 시작";
    setCameraMessage(cameraMessage, describeCameraError(error), "error");
  }
}

startButton.addEventListener("click", startCamera);
cameraStage.addEventListener("pointerup", (event) => {
  if (!sourceFrame || !cameraCapture) return;
  const bounds = canvas.getBoundingClientRect();
  const pointX = ((event.clientX - bounds.left) / bounds.width) * sourceFrame.cols;
  const pointY = ((event.clientY - bounds.top) / bounds.height) * sourceFrame.rows;
  setFlaskRegion(findFlaskAroundPoint(sourceFrame, pointX, pointY), sourceFrame);
  colorStatus.textContent = "플라스크 영역을 찾았습니다. 현재 색을 기준으로 설정해주세요.";
});
selectFlaskButton.addEventListener("click", () => {
  flaskRegion = null;
  localStorage.removeItem("titration-color-flask-region");
  setCameraMessage(cameraMessage, "플라스크 몸통 중앙을 한 번 터치하세요.");
});
baselineButton.addEventListener("click", () => {
  if (!currentColor) return;
  baselineLab = currentColor.lab;
  recentColors.length = 0;
  liveDeltaColor.textContent = "Δ색 0.0";
  colorStatus.textContent = "기준색을 저장했습니다. 적정을 시작해도 됩니다.";
});
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationFrame);
  sourceFrame?.delete();
  video.srcObject?.getTracks().forEach((track) => track.stop());
  socket.stop();
  recorder.dispose();
});

waitForOpenCv(visionStatus).catch(() => { visionStatus.textContent = "로드 실패"; });
if (!globalThis.isSecureContext) {
  setCameraMessage(cameraMessage, describeCameraError({ name: "InsecureContextError" }), "error");
  startButton.disabled = true;
}
globalThis.addEventListener("load", () => globalThis.lucide?.createIcons());