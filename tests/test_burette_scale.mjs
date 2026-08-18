import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceBuretteReading,
  evaluateOpticalAlignment,
  formatBuretteReading,
  relativeMeniscusTicks,
  roundBuretteReading,
} from "../static/burette-scale.js";

const previous = {
  meniscusY: 400,
  tickPitch: 8,
  frameCenterY: 500,
};

test("reads one tenth of a 0.1 mL graduation", () => {
  assert.equal(roundBuretteReading(8.126), 8.13);
  assert.equal(formatBuretteReading(8.126), "8.13 mL");
});

test("removes handheld vertical camera motion", () => {
  const current = {
    meniscusY: 400,
    tickPitch: 8,
    frameCenterY: 500,
  };

  assert.equal(relativeMeniscusTicks(previous, current, -16), 2);
  assert.equal(advanceBuretteReading(8.12, 2), 8.319999999999999);
  assert.equal(roundBuretteReading(advanceBuretteReading(8.12, 2)), 8.32);
});

test("removes camera scale changes around the frame center", () => {
  const zoomed = {
    meniscusY: 350,
    tickPitch: 12,
    frameCenterY: 500,
  };

  assert.ok(Math.abs(relativeMeniscusTicks(previous, zoomed, 0)) < 1e-12);
});

test("rejects invalid graduation pitches", () => {
  assert.equal(relativeMeniscusTicks(previous, { ...previous, tickPitch: 0 }, 0), null);
});

test("accepts a centered level camera with uniform perspective", () => {
  const result = evaluateOpticalAlignment({
    meniscusY: 500,
    frameHeight: 1000,
    cameraPitchDegrees: 2,
    tubeRollDegrees: 1,
    upperTickPitch: 8,
    lowerTickPitch: 8.4,
    upperTubeWidth: 40,
    lowerTubeWidth: 42,
    portrait: true,
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
});

test("rejects parallax and perspective risk independently", () => {
  const result = evaluateOpticalAlignment({
    meniscusY: 350,
    frameHeight: 1000,
    cameraPitchDegrees: 7,
    tubeRollDegrees: 4,
    upperTickPitch: 7,
    lowerTickPitch: 9,
    upperTubeWidth: 35,
    lowerTubeWidth: 42,
    portrait: false,
  });

  assert.equal(result.accepted, false);
  assert.deepEqual(result.reasons, [
    "meniscus-high",
    "camera-pitch",
    "tube-roll",
    "tick-perspective",
    "tube-perspective",
    "portrait-required",
  ]);
});

test("requires measurable perspective for scientific readings", () => {
  const result = evaluateOpticalAlignment({
    meniscusY: 500,
    frameHeight: 1000,
    upperTickPitch: null,
    lowerTickPitch: null,
    upperTubeWidth: null,
    lowerTubeWidth: null,
    requirePerspective: true,
  });

  assert.equal(result.accepted, false);
  assert.deepEqual(result.reasons, ["perspective-unavailable"]);
});