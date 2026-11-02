import timelineJson from '@/data/demo/r182-complete-flight.json';
import type { GpsSample } from '@/lib/flight-phase-detector';

type FlightSegment = {
  id: string;
  label: string;
  startSecond: number;
  endSecond: number;
  start: GpsSample;
  end: GpsSample;
};

type FlightTimeline = {
  id: string;
  label: string;
  durationSeconds: number;
  playbackStepSeconds: number;
  segments: FlightSegment[];
};

export const DEMO_FLIGHT = timelineJson as FlightTimeline;

function interpolate(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

export function sampleDemoFlight(second: number): GpsSample {
  const safeSecond = Math.max(0, Math.min(DEMO_FLIGHT.durationSeconds, Math.round(second)));
  const segment = DEMO_FLIGHT.segments.find((candidate) => safeSecond >= candidate.startSecond && safeSecond <= candidate.endSecond)
    ?? DEMO_FLIGHT.segments[DEMO_FLIGHT.segments.length - 1];
  const duration = Math.max(1, segment.endSecond - segment.startSecond);
  const progress = Math.max(0, Math.min(1, (safeSecond - segment.startSecond) / duration));
  return {
    latitude: interpolate(segment.start.latitude, segment.end.latitude, progress),
    longitude: interpolate(segment.start.longitude, segment.end.longitude, progress),
    altitudeFt: Math.round(interpolate(segment.start.altitudeFt, segment.end.altitudeFt, progress)),
    groundSpeedKt: Math.round(interpolate(segment.start.groundSpeedKt, segment.end.groundSpeedKt, progress)),
    verticalSpeedFpm: Math.round(interpolate(segment.start.verticalSpeedFpm, segment.end.verticalSpeedFpm, progress)),
    trackDegrees: Math.round(interpolate(segment.start.trackDegrees, segment.end.trackDegrees, progress)),
  };
}

export function segmentAt(second: number) {
  return DEMO_FLIGHT.segments.find((segment) => second >= segment.startSecond && second <= segment.endSecond)
    ?? DEMO_FLIGHT.segments[DEMO_FLIGHT.segments.length - 1];
}

export function formatFlightTime(second: number) {
  const minutes = Math.floor(second / 60);
  const seconds = Math.floor(second % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const COMPLETE_FLIGHT_POINTS = Array.from(
  { length: DEMO_FLIGHT.durationSeconds + 1 },
  (_, second) => sampleDemoFlight(second),
);
