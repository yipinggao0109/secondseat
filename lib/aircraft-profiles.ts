import r182Data from '@/data/aircraft/cessna-r182-1981.json';

import { loadAircraftProfile } from '@/lib/checklist-schema';

export const R182_PROFILE = loadAircraftProfile(r182Data);

export const AIRCRAFT_PROFILES = [R182_PROFILE];
