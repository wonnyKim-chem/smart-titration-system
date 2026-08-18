export const MINOR_DIVISION_ML = 0.1;
export const READING_DECIMALS = 2;
export const OPTICAL_ALIGNMENT_LIMITS = Object.freeze({
  centerOffsetRatio: 0.1,
  cameraPitchDegrees: 5,
  tubeRollDegrees: 3,
  perspectiveRatio: 0.12,
});

export function roundBuretteReading(volume) {
  const factor = 10 ** READING_DECIMALS;
  return Math.round((Number(volume) + Number.EPSILON) * factor) / factor;
}

export function formatBuretteReading(volume) {
  return `${roundBuretteReading(volume).toFixed(READING_DECIMALS)} mL`;
}

export function relativeMeniscusTicks(previous, current, scaleMotionY) {
  const previousPitch = Number(previous.tickPitch);
  const currentPitch = Number(current.tickPitch);
  if (!(previousPitch > 0) || !(currentPitch > 0)) return null;

  const scaleRatio = currentPitch / previousPitch;
  const previousCenterY = Number(previous.frameCenterY);
  const currentCenterY = Number(current.frameCenterY);
  const predictedScaleY =
    currentCenterY +
    (Number(previous.meniscusY) - previousCenterY) * scaleRatio +
    Number(scaleMotionY);
  return (Number(current.meniscusY) - predictedScaleY) / currentPitch;
}

export function advanceBuretteReading(previousVolume, relativeTicks) {
  if (!Number.isFinite(previousVolume) || !Number.isFinite(relativeTicks)) return null;
  return Number(previousVolume) + relativeTicks * MINOR_DIVISION_ML;
}

function relativeDifference(first, second) {
  if (!(first > 0) || !(second > 0)) return null;
  return Math.abs(first - second) / ((first + second) / 2);
}

export function evaluateOpticalAlignment(measurement) {
  const reasons = [];
  const centerOffset =
    (Number(measurement.meniscusY) - Number(measurement.frameHeight) / 2) /
    Number(measurement.frameHeight);
  if (centerOffset < -OPTICAL_ALIGNMENT_LIMITS.centerOffsetRatio) {
    reasons.push("meniscus-high");
  } else if (centerOffset > OPTICAL_ALIGNMENT_LIMITS.centerOffsetRatio) {
    reasons.push("meniscus-low");
  }

  if (
    Number.isFinite(measurement.cameraPitchDegrees) &&
    Math.abs(measurement.cameraPitchDegrees) > OPTICAL_ALIGNMENT_LIMITS.cameraPitchDegrees
  ) {
    reasons.push("camera-pitch");
  }
  if (
    Number.isFinite(measurement.tubeRollDegrees) &&
    Math.abs(measurement.tubeRollDegrees) > OPTICAL_ALIGNMENT_LIMITS.tubeRollDegrees
  ) {
    reasons.push("tube-roll");
  }

  const tickPerspective = relativeDifference(
    Number(measurement.upperTickPitch),
    Number(measurement.lowerTickPitch),
  );
  if (
    tickPerspective !== null &&
    tickPerspective > OPTICAL_ALIGNMENT_LIMITS.perspectiveRatio
  ) {
    reasons.push("tick-perspective");
  }
  const tubePerspective = relativeDifference(
    Number(measurement.upperTubeWidth),
    Number(measurement.lowerTubeWidth),
  );
  if (
    tubePerspective !== null &&
    tubePerspective > OPTICAL_ALIGNMENT_LIMITS.perspectiveRatio
  ) {
    reasons.push("tube-perspective");
  }
  if (measurement.requirePerspective === true && (tickPerspective === null || tubePerspective === null)) {
    reasons.push("perspective-unavailable");
  }
  if (measurement.portrait === false) reasons.push("portrait-required");

  return {
    accepted: reasons.length === 0,
    reasons,
    centerOffset,
    tickPerspective,
    tubePerspective,
  };
}