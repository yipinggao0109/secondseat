import type { PhaseDetectionConfig } from '@/lib/checklist-schema';

export type FlightPhase = 'PARKED' | 'TAXI' | 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPROACH' | 'LANDING';

export type GpsSample = {
  latitude: number;
  longitude: number;
  altitudeFt: number;
  groundSpeedKt: number;
  verticalSpeedFpm: number;
  trackDegrees: number;
};

export type PhaseDetection = {
  phase: FlightPhase;
  aglFt: number;
  reason: string;
};

export function detectFlightPhase(
  sample: GpsSample,
  config: PhaseDetectionConfig,
  previousPhase: FlightPhase,
): PhaseDetection {
  const aglFt = Math.max(0, Math.round(sample.altitudeFt - config.fieldElevationFt));
  const onGroundBand = aglFt <= config.groundBandFt;

  if (onGroundBand) {
    if (sample.groundSpeedKt >= config.airborneSpeedKt && sample.verticalSpeedFpm < -50) {
      return { phase: 'LANDING', aglFt, reason: 'Low AGL with landing speed and a descending trend' };
    }
    if (
      ['APPROACH', 'DESCENT', 'LANDING'].includes(previousPhase)
      && sample.groundSpeedKt >= config.airborneSpeedKt
    ) {
      return { phase: 'LANDING', aglFt, reason: 'Low AGL after approach with landing-roll speed' };
    }
    if (sample.groundSpeedKt < config.taxiSpeedKt) {
      return { phase: 'PARKED', aglFt, reason: 'Near field elevation and below taxi speed' };
    }
    if (sample.groundSpeedKt < config.airborneSpeedKt) {
      return { phase: 'TAXI', aglFt, reason: 'Near field elevation with ground movement' };
    }
    return { phase: previousPhase === 'LANDING' ? 'LANDING' : 'TAKEOFF', aglFt, reason: 'Near runway elevation above takeoff-speed threshold' };
  }

  if (sample.verticalSpeedFpm >= config.climbRateFpm) {
    return { phase: 'CLIMB', aglFt, reason: 'Sustained positive vertical speed' };
  }
  if (sample.verticalSpeedFpm <= config.descentRateFpm) {
    if (aglFt <= config.approachAglFt) {
      return { phase: 'APPROACH', aglFt, reason: 'Descending inside the approach AGL gate' };
    }
    return { phase: 'DESCENT', aglFt, reason: 'Sustained negative vertical speed' };
  }
  if (Math.abs(sample.verticalSpeedFpm) <= config.cruiseVerticalBandFpm) {
    return { phase: 'CRUISE', aglFt, reason: 'Altitude is stable outside the ground band' };
  }
  return { phase: previousPhase, aglFt, reason: 'Holding the last stable phase during transition' };
}
