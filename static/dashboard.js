const phPlot = document.querySelector("#phPlot");
const derivativePlot = document.querySelector("#derivativePlot");
const networkStatus = document.querySelector("#networkStatus");
const equivalenceVolume = document.querySelector("#equivalenceVolume");
const equivalencePh = document.querySelector("#equivalencePh");
const volumeCount = document.querySelector("#volumeCount");
const phCount = document.querySelector("#phCount");
const matchedCount = document.querySelector("#matchedCount");
const updatedAt = document.querySelector("#updatedAt");

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
    },
    yaxis: {
      title: yAxisTitle,
      gridcolor: "#e8ebe7",
      zerolinecolor: "#cbd1cd",
    },
    legend: { orientation: "h", x: 0, y: 1.12 },
    hovermode: "x unified",
    transition: { duration: 180, easing: "cubic-in-out" },
  };
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

  const phLayout = baseLayout("pH / Volume", "pH");
  phLayout.shapes = equivalenceShape(equivalentVolume);
  Plotly.react(phPlot, phTraces, phLayout, plotConfiguration);

  const derivativeLayout = baseLayout("First derivative", "dpH/dV");
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

  equivalenceVolume.textContent = equivalentVolume === null ? "--.--" : `${equivalentVolume.toFixed(2)} mL`;
  equivalencePh.textContent = message.equivalencePh === null ? "pH --.--" : `pH ${message.equivalencePh.toFixed(2)}`;
  volumeCount.textContent = String(message.streamCounts?.burette ?? 0);
  phCount.textContent = String(message.streamCounts?.ph ?? 0);
  matchedCount.textContent = String(message.matchedCount ?? 0);
  updatedAt.textContent = new Date(message.serverTimestamp).toLocaleTimeString("ko-KR", { hour12: false });
}

function renderEmptyPlots() {
  Plotly.newPlot(phPlot, [], baseLayout("pH / Volume", "pH"), plotConfiguration);
  Plotly.newPlot(derivativePlot, [], baseLayout("First derivative", "dpH/dV"), plotConfiguration);
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
    if (message.type === "analysis") renderAnalysis(message);
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
});