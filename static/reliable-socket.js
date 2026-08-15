import {
  getClientId,
  getPendingMeasurements,
  markMeasurementsSynced,
  saveMeasurement,
} from "./offline-store.js";

export function estimateClock(samples, maxSampleCount = 5) {
  const validSamples = samples
    .filter((sample) => Number.isFinite(sample.offset) && Number.isFinite(sample.rtt))
    .sort((left, right) => left.rtt - right.rtt)
    .slice(0, maxSampleCount);
  if (!validSamples.length) return null;
  const offsets = validSamples.map((sample) => sample.offset).sort((left, right) => left - right);
  const roundTrips = validSamples.map((sample) => sample.rtt).sort((left, right) => left - right);
  return {
    offset: offsets[Math.floor(offsets.length / 2)],
    rtt: roundTrips[Math.floor(roundTrips.length / 2)],
  };
}

export function applyClockCorrection(
  measurement,
  clientId,
  clockOffsetMs,
  clockRttMs,
  clockSynchronized,
) {
  const clientTimestamp = Number(measurement.clientTimestamp ?? measurement.timestamp ?? Date.now());
  return {
    ...measurement,
    clientId,
    clientTimestamp,
    timestamp: clientTimestamp + clockOffsetMs,
    clockOffsetMs,
    clockRttMs,
    clockSynchronized,
  };
}

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
    this.clockOffsetMs = 0;
    this.clockRttMs = null;
    this.hasClockSync = false;
    this.timeSyncSequence = 0;
    this.timeSyncWaiters = new Map();
    this.timeSyncTimer = null;
  }

  connect() {
    this.stopped = false;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${protocol}://${location.host}/ws/${this.channel}`);

    this.socket.addEventListener("open", async () => {
      this.retryDelay = 500;
      this.onConnectionChange(true);
      await this.synchronizeClock();
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.scheduleClockResync();
        this.flush();
      }
    });

    this.socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "time-sync") {
        const waiter = this.timeSyncWaiters.get(message.sequence);
        if (waiter) {
          this.timeSyncWaiters.delete(message.sequence);
          waiter.resolve({ message, clientReceiveTimestamp: Date.now() });
        }
        return;
      }
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
      clearTimeout(this.timeSyncTimer);
      for (const waiter of this.timeSyncWaiters.values()) waiter.reject(new Error("연결 종료"));
      this.timeSyncWaiters.clear();
      if (!this.stopped) this.scheduleReconnect();
    });

    this.socket.addEventListener("error", () => this.socket?.close());
  }

  requestTimeSyncSample() {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("연결 없음"));
    const sequence = ++this.timeSyncSequence;
    const clientSendTimestamp = Date.now();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.timeSyncWaiters.delete(sequence);
        reject(new Error("시각 동기화 시간 초과"));
      }, 1_500);
      this.timeSyncWaiters.set(sequence, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ type: "time-sync", sequence, clientSendTimestamp }));
    });
  }

  async synchronizeClock() {
    const samples = [];
    for (let index = 0; index < 7; index += 1) {
      try {
        const { message, clientReceiveTimestamp } = await this.requestTimeSyncSample();
        const clientSendTimestamp = Number(message.clientSendTimestamp);
        const serverReceiveTimestamp = Number(message.serverReceiveTimestamp);
        const serverSendTimestamp = Number(message.serverSendTimestamp);
        const rtt = Math.max(
          0,
          clientReceiveTimestamp - clientSendTimestamp - (serverSendTimestamp - serverReceiveTimestamp),
        );
        const offset =
          ((serverReceiveTimestamp - clientSendTimestamp) +
            (serverSendTimestamp - clientReceiveTimestamp)) /
          2;
        if (Number.isFinite(offset) && Number.isFinite(rtt)) samples.push({ offset, rtt });
      } catch {
        break;
      }
    }
    const estimate = estimateClock(samples);
    if (!estimate) return false;
    this.clockOffsetMs = estimate.offset;
    this.clockRttMs = estimate.rtt;
    this.hasClockSync = true;
    if (this.experimentStatusElement) {
      this.experimentStatusElement.title = `서버 시각 보정 ${this.clockOffsetMs.toFixed(1)} ms · 왕복 ${this.clockRttMs.toFixed(1)} ms`;
    }
    return true;
  }

  scheduleClockResync() {
    clearTimeout(this.timeSyncTimer);
    this.timeSyncTimer = setTimeout(async () => {
      await this.synchronizeClock();
      if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) this.scheduleClockResync();
    }, this.hasClockSync ? 5 * 60 * 1_000 : 5_000);
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
    await saveMeasurement(
      this.channel,
      applyClockCorrection(
        measurement,
        this.clientId,
        this.clockOffsetMs,
        this.clockRttMs,
        this.hasClockSync,
      ),
    );
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
    clearTimeout(this.timeSyncTimer);
    this.socket?.close();
  }
}