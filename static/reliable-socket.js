import {
  getClientId,
  getPendingMeasurements,
  markMeasurementsSynced,
  saveMeasurement,
} from "./offline-store.js";

export class ReliableMeasurementSocket {
  constructor(channel, onConnectionChange = () => {}) {
    this.channel = channel;
    this.clientId = getClientId(channel);
    this.onConnectionChange = onConnectionChange;
    this.experimentStatusElement = document.querySelector("#experimentStatus");
    this.socket = null;
    this.retryDelay = 500;
    this.retryTimer = null;
    this.inflightIds = new Set();
    this.flushing = false;
    this.stopped = false;
  }

  connect() {
    this.stopped = false;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${protocol}://${location.host}/ws/${this.channel}`);

    this.socket.addEventListener("open", () => {
      this.retryDelay = 500;
      this.onConnectionChange(true);
      this.flush();
    });

    this.socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "experiment-status") {
        this.updateExperimentStatus(message.experiments ?? []);
        return;
      }
      if (message.type !== "ack") return;
      const rejectedIds = (message.rejected ?? []).map((item) => item.id).filter(Boolean);
      await markMeasurementsSynced([...(message.ids ?? []), ...rejectedIds]);
      for (const id of message.ids ?? []) this.inflightIds.delete(id);
      for (const id of rejectedIds) this.inflightIds.delete(id);
      this.flush();
    });

    this.socket.addEventListener("close", () => {
      this.onConnectionChange(false);
      this.inflightIds.clear();
      if (!this.stopped) this.scheduleReconnect();
    });

    this.socket.addEventListener("error", () => this.socket?.close());
  }

  updateExperimentStatus(experiments) {
    if (!this.experimentStatusElement) return;
    const titles = experiments.map((experiment) => experiment.title);
    this.experimentStatusElement.classList.toggle("recording", titles.length > 0);
    if (titles.length === 0) {
      this.experimentStatusElement.textContent = "대시보드에서 데이터 입력을 시작하세요.";
    } else if (titles.length === 1) {
      this.experimentStatusElement.textContent = `“${titles[0]}” 데이터 입력 중`;
    } else {
      this.experimentStatusElement.textContent = `${titles.length}개 실험 동시 입력 중: ${titles.join(", ")}`;
    }
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 1.8, 10_000);
  }

  async storeAndSend(measurement) {
    // 네트워크 상태와 관계없이 로컬 저장 완료를 전송보다 먼저 보장한다.
    await saveMeasurement(this.channel, { ...measurement, clientId: this.clientId });
    await this.flush();
  }

  async flush() {
    if (this.flushing || this.socket?.readyState !== WebSocket.OPEN) return;
    this.flushing = true;
    try {
      const pending = await getPendingMeasurements(this.channel);
      const records = pending
        .filter((record) => !this.inflightIds.has(record.id))
        .map((record) => ({ ...record, clientId: record.clientId ?? this.clientId }));
      if (!records.length) return;
      records.forEach((record) => this.inflightIds.add(record.id));
      this.socket.send(JSON.stringify({ type: "batch", records }));
    } finally {
      this.flushing = false;
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}