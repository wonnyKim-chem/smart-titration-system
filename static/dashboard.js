const phPlot = document.querySelector("#phPlot");
const derivativePlot = document.querySelector("#derivativePlot");
const secondDerivativePlot = document.querySelector("#secondDerivativePlot");
const temperaturePlot = document.querySelector("#temperaturePlot");
const colorPlot = document.querySelector("#colorPlot");
const networkStatus = document.querySelector("#networkStatus");
const equivalenceVolume = document.querySelector("#equivalenceVolume");
const equivalencePh = document.querySelector("#equivalencePh");
const colorEndpointVolume = document.querySelector("#colorEndpointVolume");
const colorEndpointDelta = document.querySelector("#colorEndpointDelta");
const temperaturePeakVolume = document.querySelector("#temperaturePeakVolume");
const temperaturePeak = document.querySelector("#temperaturePeak");
const colorCalibrationNotice = document.querySelector("#colorCalibrationNotice");
const sensorWarnings = document.querySelector("#sensorWarnings");
const volumeCount = document.querySelector("#volumeCount");
const phCount = document.querySelector("#phCount");
const temperatureCount = document.querySelector("#temperatureCount");
const colorCount = document.querySelector("#colorCount");
const matchedCount = document.querySelector("#matchedCount");
const updatedAt = document.querySelector("#updatedAt");
const currentExperimentTitle = document.querySelector("#currentExperimentTitle");
const collectionStatus = document.querySelector("#collectionStatus");
const newExperimentButton = document.querySelector("#newExperiment");
const startCollectionButton = document.querySelector("#startCollection");
const stopCollectionButton = document.querySelector("#stopCollection");
const exportCsvButton = document.querySelector("#exportCsv");
const exportXlsxButton = document.querySelector("#exportXlsx");
const savePlotsButton = document.querySelector("#savePlots");
const refreshExperimentsButton = document.querySelector("#refreshExperiments");
const toggleDeleteModeButton = document.querySelector("#toggleDeleteMode");
const experimentList = document.querySelector("#experimentList");
const newExperimentDialog = document.querySelector("#newExperimentDialog");
const newExperimentForm = document.querySelector("#newExperimentForm");
const experimentTitleInput = document.querySelector("#experimentTitleInput");
const cancelNewExperimentButton = document.querySelector("#cancelNewExperiment");
const recordingConflictDialog = document.querySelector("#recordingConflictDialog");
const continueAndCreateButton = document.querySelector("#continueAndCreate");
const stopAndCreateButton = document.querySelector("#stopAndCreate");
const cancelConflictButton = document.querySelector("#cancelConflict");
const duplicateTitleDialog = document.querySelector("#duplicateTitleDialog");
const duplicateTitleMessage = document.querySelector("#duplicateTitleMessage");
const suffixTitleLabel = document.querySelector("#suffixTitleLabel");
const addTitleSuffixButton = document.querySelector("#addTitleSuffix");
const retryExperimentTitleButton = document.querySelector("#retryExperimentTitle");
const cancelDuplicateTitleButton = document.querySelector("#cancelDuplicateTitle");

let currentExperiment = null;
let experiments = [];
let pendingExperimentTitle = null;
let pendingDuplicateRequest = null;
let deleteMode = false;

const plotConfiguration = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
};

function baseLayout(title, yAxisTitle) {
  return {
    title: { text: title, x: 0.04, xanchor: "left", font: { family: "Noto Sans KR", size: 17 } },
    margin: { l: 62, r: 24, t: 58, b: 54 },
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    font: { family: "Noto Sans KR", color: "#17201f" },
    xaxis: {
      title: "부피 (mL)",
      gridcolor: "#e8ebe7",
      zerolinecolor: "#cbd1cd",
      rangemode: "tozero",
      autorange: true,
      automargin: true,
    },
    yaxis: {
      title: yAxisTitle,
      gridcolor: "#e8ebe7",
      zerolinecolor: "#cbd1cd",
      autorange: true,
      automargin: true,
    },
    legend: { orientation: "h", x: 0, y: 1.12 },
    hovermode: "x unified",
  };
}

function applyVolumeRange(layout, ...volumeAxes) {
  const values = volumeAxes.flat().filter((value) => Number.isFinite(Number(value))).map(Number);
  const maximum = Math.max(0, ...values);
  layout.xaxis.range = [0, maximum > 0 ? maximum * 1.04 : 1];
  layout.xaxis.autorange = false;
  layout.yaxis.autorange = true;
  return layout;
}

function equivalenceShape(volume) {
  if (volume === null) return [];
  return [
    {
      type: "line",
      x0: volume,
      x1: volume,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color: "#c44235", width: 3, dash: "dot" },
    },
  ];
}

function renderAnalysis(message) {
  const volume = message.volume ?? [];
  const rawPh = message.ph ?? [];
  const smoothedPh = message.smoothedPh?.length ? message.smoothedPh : rawPh;
  const firstDerivative = message.firstDerivative ?? [];
  const secondDerivative = message.secondDerivative ?? [];
  const equivalentVolume = message.equivalenceVolume;
  const equivalentIndex = equivalentVolume === null ? -1 : volume.indexOf(equivalentVolume);

  const phTraces = [
    {
      x: volume,
      y: rawPh,
      name: "원시 pH",
      mode: "markers",
      marker: { color: "#8c9995", size: 5, opacity: 0.55 },
    },
    {
      x: volume,
      y: smoothedPh,
      name: "평활 pH",
      mode: "lines",
      line: { color: "#087f6d", width: 3 },
    },
  ];
  if (equivalentIndex >= 0) {
    phTraces.push({
      x: [equivalentVolume],
      y: [smoothedPh[equivalentIndex]],
      name: "당량점",
      mode: "markers",
      marker: { color: "#f1c84a", line: { color: "#17201f", width: 2 }, size: 13 },
    });
  }

  const phLayout = applyVolumeRange(baseLayout("pH / Volume", "pH"), volume);
  phLayout.shapes = equivalenceShape(equivalentVolume);
  Plotly.react(phPlot, phTraces, phLayout, plotConfiguration);

  const derivativeLayout = applyVolumeRange(baseLayout("First derivative", "dpH/dV"), volume);
  derivativeLayout.shapes = equivalenceShape(equivalentVolume);
  Plotly.react(
    derivativePlot,
    [
      {
        x: firstDerivative.length ? volume : [],
        y: firstDerivative,
        name: "dpH/dV",
        mode: "lines",
        fill: "tozeroy",
        fillcolor: "rgba(241, 200, 74, 0.22)",
        line: { color: "#c44235", width: 2.5 },
      },
    ],
    derivativeLayout,
    plotConfiguration,
  );

  const secondDerivativeLayout = applyVolumeRange(
    baseLayout("Second derivative", "d²pH/dV²"),
    volume,
  );
  secondDerivativeLayout.shapes = equivalenceShape(equivalentVolume);
  Plotly.react(
    secondDerivativePlot,
    [
      {
        x: secondDerivative.length ? volume : [],
        y: secondDerivative,
        name: "d²pH/dV²",
        mode: "lines",
        line: { color: "#316a9e", width: 2.5 },
        zeroLine: true,
      },
    ],
    secondDerivativeLayout,
    plotConfiguration,
  );

  const temperatureVolume = message.temperatureVolume ?? [];
  const temperature = message.temperature ?? [];
  const temperatureLayout = applyVolumeRange(
    baseLayout("온도 / 부피", "온도 (°C)"),
    temperatureVolume,
  );
  temperatureLayout.shapes = equivalenceShape(message.temperaturePeakVolume);
  Plotly.react(
    temperaturePlot,
    [
      {
        x: temperatureVolume,
        y: temperature,
        name: "온도",
        mode: "lines+markers",
        line: { color: "#c44235", width: 2.5 },
        marker: { size: 5 },
      },
      {
        x: message.temperaturePeakVolume === null ? [] : [message.temperaturePeakVolume],
        y: message.temperaturePeak === null ? [] : [message.temperaturePeak],
        name: "최고점",
        mode: "markers",
        marker: { color: "#f1c84a", line: { color: "#17201f", width: 2 }, size: 13 },
      },
    ],
    temperatureLayout,
    plotConfiguration,
  );

  const colorVolume = message.colorVolume ?? [];
  const deltaColor = message.deltaColor ?? [];
  const colorLayout = applyVolumeRange(baseLayout("Δ색 / 부피", "Δ색"), colorVolume);
  colorLayout.shapes = equivalenceShape(message.colorEndpointVolume);
  Plotly.react(
    colorPlot,
    [
      {
        x: colorVolume,
        y: deltaColor,
        name: "Δ색",
        mode: "lines+markers",
        line: { color: "#9b5c36", width: 2.5 },
        marker: { color: deltaColor, colorscale: "Viridis", size: 6 },
      },
      {
        x: message.colorEndpointVolume === null ? [] : [message.colorEndpointVolume],
        y: message.colorEndpointDelta === null ? [] : [message.colorEndpointDelta],
        name: "색 종말점",
        mode: "markers",
        marker: { color: "#f1c84a", line: { color: "#17201f", width: 2 }, size: 13 },
      },
    ],
    colorLayout,
    plotConfiguration,
  );

  equivalenceVolume.textContent = equivalentVolume === null ? "--.--" : `${equivalentVolume.toFixed(2)} mL`;
  equivalencePh.textContent = message.equivalencePh === null ? "pH --.--" : `pH ${message.equivalencePh.toFixed(2)}`;
  colorEndpointVolume.textContent = message.colorEndpointVolume === null ? "--.--" : `${message.colorEndpointVolume.toFixed(2)} mL`;
  colorEndpointDelta.textContent = message.colorEndpointDelta === null ? "Δ색 --.-" : `Δ색 ${message.colorEndpointDelta.toFixed(1)}`;
  temperaturePeakVolume.textContent = message.temperaturePeakVolume === null ? "--.--" : `${message.temperaturePeakVolume.toFixed(2)} mL`;
  temperaturePeak.textContent = message.temperaturePeak === null ? "--.- °C" : `${message.temperaturePeak.toFixed(1)} °C`;
  volumeCount.textContent = String(message.streamCounts?.burette ?? 0);
  phCount.textContent = String(message.streamCounts?.ph ?? 0);
  temperatureCount.textContent = String(message.streamCounts?.temperature ?? 0);
  colorCount.textContent = String(message.streamCounts?.color ?? 0);
  matchedCount.textContent = String(message.matchedCount ?? 0);
  updatedAt.textContent = new Date(message.serverTimestamp).toLocaleTimeString("ko-KR", { hour12: false });
  colorCalibrationNotice.classList.toggle("hidden", colorVolume.length === 0 || rawPh.length > 0);
  const warnings = message.sensorWarnings ?? [];
  sensorWarnings.classList.toggle("hidden", warnings.length === 0);
  sensorWarnings.textContent = warnings.join(" ");
  updateCurrentExperiment(message.experiment);
}

function renderEmptyPlots() {
  Plotly.newPlot(phPlot, [], applyVolumeRange(baseLayout("pH / Volume", "pH"), []), plotConfiguration);
  Plotly.newPlot(derivativePlot, [], applyVolumeRange(baseLayout("First derivative", "dpH/dV"), []), plotConfiguration);
  Plotly.newPlot(secondDerivativePlot, [], applyVolumeRange(baseLayout("Second derivative", "d²pH/dV²"), []), plotConfiguration);
  Plotly.newPlot(temperaturePlot, [], applyVolumeRange(baseLayout("온도 / 부피", "온도 (°C)"), []), plotConfiguration);
  Plotly.newPlot(colorPlot, [], applyVolumeRange(baseLayout("Δ색 / 부피", "Δ색"), []), plotConfiguration);
}

function updateCurrentExperiment(experiment) {
  currentExperiment = experiment;
  const exists = Boolean(experiment?.id);
  const recording = experiment?.status === "recording";
  currentExperimentTitle.textContent = exists ? experiment.title : "선택된 실험 없음";
  collectionStatus.textContent = recording ? "데이터 입력 중" : "입력 중지";
  collectionStatus.classList.toggle("recording", recording);
  startCollectionButton.disabled = !exists || recording;
  stopCollectionButton.disabled = !exists || !recording;
  startCollectionButton.classList.toggle("collection-start-active", exists && !recording);
  stopCollectionButton.classList.toggle("collection-stop-active", recording);
  exportCsvButton.disabled = !exists;
  exportXlsxButton.disabled = !exists;
  savePlotsButton.disabled = !exists;
  renderExperimentList();
}

function renderExperimentList() {
  experimentList.replaceChildren();
  if (!experiments.length) {
    const empty = document.createElement("p");
    empty.textContent = "저장된 실험이 없습니다.";
    experimentList.append(empty);
    return;
  }
  for (const experiment of experiments) {
    const row = document.createElement("div");
    row.className = "experiment-list-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "experiment-list-item";
    button.classList.toggle("active", experiment.id === currentExperiment?.id);
    button.classList.toggle("recording", experiment.status === "recording");
    const title = document.createElement("strong");
    title.textContent = experiment.title;
    const detail = document.createElement("span");
    const date = new Date(experiment.createdAt).toLocaleString("ko-KR", { hour12: false });
    detail.textContent = `${date} · ${experiment.recordCount}개 · ${experiment.status === "recording" ? "입력 중" : "중지"}`;
    button.append(title, detail);
    button.addEventListener("click", () => selectExperiment(experiment.id));
    row.append(button);
    if (deleteMode) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "experiment-delete-button";
      deleteButton.title = `${experiment.title} 삭제`;
      deleteButton.setAttribute("aria-label", `${experiment.title} 삭제`);
      deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
      deleteButton.addEventListener("click", () => deleteExperiment(experiment));
      row.append(deleteButton);
    }
    experimentList.append(row);
  }
  globalThis.lucide?.createIcons();
}

async function deleteExperiment(experiment) {
  const confirmed = confirm(
    `“${experiment.title}” 실험을 삭제하시겠습니까?\n\n실험 데이터가 모두 삭제되며 이 작업은 되돌릴 수 없습니다.`,
  );
  if (!confirmed) return;
  const { response, body } = await requestJson(`/api/experiments/${experiment.id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    alert(body.message ?? "실험을 삭제하지 못했습니다.");
    return;
  }
  if (currentExperiment?.id === experiment.id) {
    updateCurrentExperiment(body.activeExperiment);
  }
  await loadExperiments(false);
  if (!experiments.length) {
    deleteMode = false;
    toggleDeleteModeButton.classList.remove("active");
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { response, body };
}

async function loadExperiments(autoSelect = true) {
  const response = await fetch("/api/experiments");
  const body = await response.json();
  experiments = body.experiments ?? [];
  renderExperimentList();
  if (autoSelect && !currentExperiment && experiments.length) {
    await selectExperiment(body.activeId ?? experiments[0].id, false);
  } else if (!experiments.length && !currentExperiment && !newExperimentDialog.open) {
    openNewExperimentDialog();
  }
}

function openNewExperimentDialog(initialTitle = "실험 1") {
  experimentTitleInput.value = initialTitle;
  newExperimentDialog.showModal();
  requestAnimationFrame(() => {
    experimentTitleInput.focus();
    experimentTitleInput.select();
  });
}

async function createExperiment(title, recordingAction = "", duplicateAction = "") {
  const { response, body } = await requestJson("/api/experiments", {
    method: "POST",
    body: JSON.stringify({ title, recordingAction, duplicateAction }),
  });
  if (!response.ok) {
    if (body.code === "duplicate-title") {
      pendingDuplicateRequest = { title: body.title ?? title, recordingAction };
      duplicateTitleMessage.textContent = `${body.message} 기존 데이터는 덮어쓰지 않습니다.`;
      suffixTitleLabel.textContent = `“${body.suggestedTitle}”로 추가`;
      duplicateTitleDialog.showModal();
      return;
    }
    alert(body.message ?? "실험을 만들지 못했습니다.");
    return;
  }
  updateCurrentExperiment(body.experiment);
  await loadExperiments(false);
}

async function selectExperiment(experimentId) {
  if (experimentId === currentExperiment?.id) return;
  const { response, body } = await requestJson(`/api/experiments/${experimentId}/select`, {
    method: "POST",
    body: "{}",
  });
  if (!response.ok) {
    alert(body.message ?? "실험을 선택하지 못했습니다.");
    return;
  }
  updateCurrentExperiment(body.experiment);
  await loadExperiments(false);
}

async function setCollectionState(recording) {
  if (!currentExperiment) return;
  const action = recording ? "start" : "stop";
  const { response, body } = await requestJson(
    `/api/experiments/${currentExperiment.id}/${action}`,
    { method: "POST", body: "{}" },
  );
  if (!response.ok) {
    alert(body.message ?? "입력 상태를 변경하지 못했습니다.");
    return;
  }
  updateCurrentExperiment(body.experiment);
  await loadExperiments(false);
}

function downloadExperimentFile(extension) {
  if (!currentExperiment) return;
  location.href = `/api/experiments/${currentExperiment.id}/export.${extension}`;
}

function safeDownloadName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "실험";
}

async function saveAllPlots() {
  if (!currentExperiment) return;
  const title = safeDownloadName(currentExperiment.title);
  const plots = [
    [phPlot, "pH-부피"],
    [derivativePlot, "dpH-dV"],
    [secondDerivativePlot, "d2pH-dV2"],
    [temperaturePlot, "온도-부피"],
    [colorPlot, "델타색-부피"],
  ];
  for (const [plot, name] of plots) {
    await Plotly.downloadImage(plot, {
      format: "png",
      filename: `${title}-${name}`,
      width: 1400,
      height: 800,
      scale: 1,
    });
  }
}

const plotDownloads = {
  ph: [phPlot, "pH-부피"],
  first: [derivativePlot, "dpH-dV"],
  second: [secondDerivativePlot, "d2pH-dV2"],
  temperature: [temperaturePlot, "온도-부피"],
  color: [colorPlot, "델타색-부피"],
};

async function saveSinglePlot(plotKey) {
  if (!currentExperiment || !plotDownloads[plotKey]) return;
  const [plot, name] = plotDownloads[plotKey];
  await Plotly.downloadImage(plot, {
    format: "png",
    filename: `${safeDownloadName(currentExperiment.title)}-${name}`,
    width: 1400,
    height: 800,
    scale: 1,
  });
}

function connectDashboard() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws/dashboard`);
  socket.addEventListener("open", () => {
    networkStatus.textContent = "실시간 연결됨";
    networkStatus.classList.add("online");
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "analysis") {
      const recordingIds = new Set((message.recordingExperiments ?? []).map((item) => item.id));
      experiments = experiments.map((item) => ({
        ...item,
        status: recordingIds.has(item.id) ? "recording" : "stopped",
      }));
      renderAnalysis(message);
    }
  });
  socket.addEventListener("close", () => {
    networkStatus.textContent = "재연결 중";
    networkStatus.classList.remove("online");
    setTimeout(connectDashboard, 1_000);
  });
  socket.addEventListener("error", () => socket.close());
}

window.addEventListener("load", () => {
  globalThis.lucide?.createIcons();
  renderEmptyPlots();
  connectDashboard();
  loadExperiments();
});

newExperimentButton.addEventListener("click", () => {
  openNewExperimentDialog();
});
newExperimentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = experimentTitleInput.value.trim();
  if (!title) return;
  newExperimentDialog.close();
  if (experiments.some((experiment) => experiment.status === "recording")) {
    pendingExperimentTitle = title;
    recordingConflictDialog.showModal();
    return;
  }
  await createExperiment(title);
});
cancelNewExperimentButton.addEventListener("click", () => newExperimentDialog.close());
startCollectionButton.addEventListener("click", () => setCollectionState(true));
stopCollectionButton.addEventListener("click", () => setCollectionState(false));
exportCsvButton.addEventListener("click", () => downloadExperimentFile("csv"));
exportXlsxButton.addEventListener("click", () => downloadExperimentFile("xlsx"));
savePlotsButton.addEventListener("click", saveAllPlots);
refreshExperimentsButton.addEventListener("click", () => loadExperiments(false));
toggleDeleteModeButton.addEventListener("click", () => {
  deleteMode = !deleteMode;
  toggleDeleteModeButton.classList.toggle("active", deleteMode);
  toggleDeleteModeButton.title = deleteMode ? "삭제 모드 종료" : "실험 삭제 모드";
  renderExperimentList();
});
continueAndCreateButton.addEventListener("click", async () => {
  recordingConflictDialog.close();
  const title = pendingExperimentTitle;
  pendingExperimentTitle = null;
  if (title) await createExperiment(title, "continue");
});
stopAndCreateButton.addEventListener("click", async () => {
  recordingConflictDialog.close();
  const title = pendingExperimentTitle;
  pendingExperimentTitle = null;
  if (title) await createExperiment(title, "stop");
});
cancelConflictButton.addEventListener("click", () => {
  pendingExperimentTitle = null;
  recordingConflictDialog.close();
});
document.querySelectorAll(".plot-download").forEach((button) => {
  button.addEventListener("click", () => saveSinglePlot(button.dataset.plot));
});
addTitleSuffixButton.addEventListener("click", async () => {
  duplicateTitleDialog.close();
  const request = pendingDuplicateRequest;
  pendingDuplicateRequest = null;
  if (request) await createExperiment(request.title, request.recordingAction, "suffix");
});
retryExperimentTitleButton.addEventListener("click", () => {
  const request = pendingDuplicateRequest;
  pendingDuplicateRequest = null;
  duplicateTitleDialog.close();
  openNewExperimentDialog(request?.title ?? "실험 1");
});
cancelDuplicateTitleButton.addEventListener("click", () => {
  pendingDuplicateRequest = null;
  duplicateTitleDialog.close();
});