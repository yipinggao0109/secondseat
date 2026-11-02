export type RunStatus = 'waiting' | 'confirmed' | 'mismatch' | 'unresolved';
export type ChecklistCategory = 'normal' | 'emergency';
export type ChecklistItem = {
  id: string;
  challenge: string;
  expected: string;
  validator: 'exact' | 'range';
  min?: number;
  max?: number;
  status?: RunStatus;
  response?: string;
};
export type ChecklistSection = {
  id: string;
  name: string;
  category: ChecklistCategory;
  group: string;
  sourcePage: string;
  sourceKind?: 'poh-checklist' | 'poh-amplified' | 'prototype-supplement';
  appliesTo?: 'night';
  triggerPhase?: string;
  items: ChecklistItem[];
};
export type PhaseDetectionConfig = {
  fieldElevationFt: number;
  taxiSpeedKt: number;
  airborneSpeedKt: number;
  climbRateFpm: number;
  descentRateFpm: number;
  cruiseVerticalBandFpm: number;
  approachAglFt: number;
  groundBandFt: number;
};
export type AircraftProfile = {
  schemaVersion: 1;
  aircraft: {
    id: string;
    manufacturer: string;
    model: string;
    displayName: string;
    year?: number;
    configuration: string[];
  };
  source: {
    kind: string;
    title: string;
    revision?: string;
    url?: string;
    note?: string;
  };
  modes: Array<{ id: string; label: string; description: string }>;
  phaseDetection?: PhaseDetectionConfig;
  checklists: ChecklistSection[];
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

export function loadAircraftProfile(input: unknown): AircraftProfile {
  const profile = record(input, 'profile');
  if (profile.schemaVersion !== 1) throw new Error('Unsupported aircraft-profile schema version.');
  const aircraft = record(profile.aircraft, 'aircraft');
  string(aircraft.id, 'aircraft.id');
  string(aircraft.manufacturer, 'aircraft.manufacturer');
  string(aircraft.model, 'aircraft.model');
  string(aircraft.displayName, 'aircraft.displayName');
  if (!Array.isArray(aircraft.configuration)) throw new Error('aircraft.configuration must be an array.');

  const source = record(profile.source, 'source');
  string(source.kind, 'source.kind');
  string(source.title, 'source.title');
  if (!Array.isArray(profile.modes)) throw new Error('modes must be an array.');
  if (profile.phaseDetection !== undefined) {
    const phaseDetection = record(profile.phaseDetection, 'phaseDetection');
    for (const key of ['fieldElevationFt', 'taxiSpeedKt', 'airborneSpeedKt', 'climbRateFpm', 'descentRateFpm', 'cruiseVerticalBandFpm', 'approachAglFt', 'groundBandFt']) {
      if (typeof phaseDetection[key] !== 'number') throw new Error(`phaseDetection.${key} must be a number.`);
    }
  }
  if (!Array.isArray(profile.checklists) || !profile.checklists.length) throw new Error('checklists must be a non-empty array.');

  const sectionIds = new Set<string>();
  for (const [sectionIndex, sectionValue] of profile.checklists.entries()) {
    const section = record(sectionValue, `checklists[${sectionIndex}]`);
    const sectionId = string(section.id, `checklists[${sectionIndex}].id`);
    if (sectionIds.has(sectionId)) throw new Error(`Duplicate checklist id: ${sectionId}`);
    sectionIds.add(sectionId);
    string(section.name, `${sectionId}.name`);
    if (section.category !== 'normal' && section.category !== 'emergency') throw new Error(`${sectionId}.category is invalid.`);
    string(section.group, `${sectionId}.group`);
    string(section.sourcePage, `${sectionId}.sourcePage`);
    if (!Array.isArray(section.items) || !section.items.length) throw new Error(`${sectionId}.items must be a non-empty array.`);

    const itemIds = new Set<string>();
    for (const [itemIndex, itemValue] of section.items.entries()) {
      const item = record(itemValue, `${sectionId}.items[${itemIndex}]`);
      const itemId = string(item.id, `${sectionId}.items[${itemIndex}].id`);
      if (itemIds.has(itemId)) throw new Error(`Duplicate item id in ${sectionId}: ${itemId}`);
      itemIds.add(itemId);
      string(item.challenge, `${itemId}.challenge`);
      if (typeof item.expected !== 'string') throw new Error(`${itemId}.expected must be a string.`);
      if (item.validator !== 'exact' && item.validator !== 'range') throw new Error(`${itemId}.validator is invalid.`);
      if (item.validator === 'range' && (typeof item.min !== 'number' || typeof item.max !== 'number')) {
        throw new Error(`${itemId} requires numeric min and max values.`);
      }
    }
  }

  return input as AircraftProfile;
}
